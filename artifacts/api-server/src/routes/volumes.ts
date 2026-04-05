import { Router } from "express";
import { db, volumesTable, gpuProfilesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import * as vastai from "../services/vastai";
import { logger } from "../lib/logger";

const router = Router();

// GET /volumes — list all volumes with associated profile info
router.get("/volumes", async (_req, res) => {
  const volumes = await db
    .select({
      id: volumesTable.id,
      profileId: volumesTable.profileId,
      profileName: gpuProfilesTable.displayName,
      vastVolumeId: volumesTable.vastVolumeId,
      name: volumesTable.name,
      status: volumesTable.status,
      sizeGb: volumesTable.sizeGb,
      statusMessage: volumesTable.statusMessage,
      provisioningInstanceId: volumesTable.provisioningInstanceId,
      createdAt: volumesTable.createdAt,
      updatedAt: volumesTable.updatedAt,
    })
    .from(volumesTable)
    .leftJoin(gpuProfilesTable, eq(volumesTable.profileId, gpuProfilesTable.id))
    .orderBy(desc(volumesTable.createdAt));

  res.json(volumes);
});

// GET /volumes/:id — get a single volume with status sync from Vast.ai
router.get("/volumes/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid volume ID" });
    return;
  }

  const [volume] = await db
    .select({
      id: volumesTable.id,
      profileId: volumesTable.profileId,
      profileName: gpuProfilesTable.displayName,
      vastVolumeId: volumesTable.vastVolumeId,
      name: volumesTable.name,
      status: volumesTable.status,
      sizeGb: volumesTable.sizeGb,
      statusMessage: volumesTable.statusMessage,
      provisioningInstanceId: volumesTable.provisioningInstanceId,
      createdAt: volumesTable.createdAt,
      updatedAt: volumesTable.updatedAt,
    })
    .from(volumesTable)
    .leftJoin(gpuProfilesTable, eq(volumesTable.profileId, gpuProfilesTable.id))
    .where(eq(volumesTable.id, id));

  if (!volume) {
    res.status(404).json({ error: "Volume not found" });
    return;
  }

  // If provisioning, check the provisioning instance status
  if (volume.status === "provisioning" && volume.provisioningInstanceId) {
    try {
      const instance = await vastai.getInstance(volume.provisioningInstanceId);
      const vastStatus = instance.actual_status || "";
      const statusMsg = (instance.status_msg || "").toLowerCase();

      let newStatus = volume.status;
      let newMessage = volume.statusMessage;

      if (vastStatus === "running") {
        // If model download is complete, mark volume as ready
        if (statusMsg.includes("llm_ready") || statusMsg.includes("ready")) {
          newStatus = "ready";
          newMessage = "Model weights cached — volume ready";
          // Destroy the provisioning instance now that model is downloaded
          try {
            await vastai.destroyInstance(volume.provisioningInstanceId);
          } catch {
            logger.warn({ instanceId: volume.provisioningInstanceId }, "Failed to destroy provisioning instance");
          }
          await db
            .update(volumesTable)
            .set({
              status: newStatus,
              statusMessage: newMessage,
              provisioningInstanceId: null,
              updatedAt: new Date(),
            })
            .where(eq(volumesTable.id, id));
        } else if (statusMsg.includes("downloading") || statusMsg.includes("starting_llm")) {
          newStatus = "provisioning";
          newMessage = "Downloading model weights to volume...";
          await db
            .update(volumesTable)
            .set({ statusMessage: newMessage, updatedAt: new Date() })
            .where(eq(volumesTable.id, id));
        }
      } else if (vastStatus === "exited" || vastStatus === "error") {
        newStatus = "error";
        newMessage = `Provisioning failed: ${instance.status_msg || vastStatus}`;
        await db
          .update(volumesTable)
          .set({ status: newStatus, statusMessage: newMessage, updatedAt: new Date() })
          .where(eq(volumesTable.id, id));
      }

      res.json({ ...volume, status: newStatus, statusMessage: newMessage });
      return;
    } catch (err) {
      logger.warn({ err, volumeId: id }, "Failed to sync volume provisioning status");
    }
  }

  res.json(volume);
});

// POST /volumes — create a Vast.ai volume and start a provisioning instance
// to download model weights into it.
router.post("/volumes", async (req, res) => {
  const { profileId, name, sizeGb } = req.body;

  if (!profileId) {
    res.status(400).json({ error: "profileId is required" });
    return;
  }

  const [profile] = await db
    .select()
    .from(gpuProfilesTable)
    .where(eq(gpuProfilesTable.id, profileId));

  if (!profile) {
    res.status(404).json({ error: "GPU profile not found" });
    return;
  }

  // Check if a volume already exists for this profile (not in error state)
  const [existing] = await db
    .select()
    .from(volumesTable)
    .where(eq(volumesTable.profileId, profileId));

  if (existing && existing.status !== "error") {
    res.status(409).json({ error: `A volume already exists for this profile (status: ${existing.status})` });
    return;
  }

  const volumeName = name || `omniql-${profile.name}-models`;
  const volumeSizeGb = sizeGb || Math.max(profile.quantSizeGb + 20, 200);

  let volumeDbId: number | undefined;

  try {
    // Step 1: Create the Vast.ai volume
    logger.info({ profileId, volumeName, volumeSizeGb }, "Creating Vast.ai volume");
    const vastVolume = await vastai.createVolume(volumeName, volumeSizeGb);
    const vastVolumeId = vastVolume.id!;

    // Step 2: Insert the volume record in DB
    const [volumeRecord] = await db
      .insert(volumesTable)
      .values({
        profileId,
        vastVolumeId,
        name: volumeName,
        status: "provisioning",
        sizeGb: volumeSizeGb,
        statusMessage: "Volume created — starting model download instance...",
      })
      .returning();

    volumeDbId = volumeRecord.id;

    // Step 3: Find the cheapest offer for this profile to run the download
    const searchParams = (profile.searchParams as Record<string, unknown>) || {};
    const offers = await vastai.searchOffers({
      gpu_name: searchParams.gpu_name as string,
      num_gpus: searchParams.num_gpus as number,
      min_gpu_ram: searchParams.min_gpu_ram as number,
      disk_space: 50, // minimal disk for provisioning
      limit: 3,
    });

    if (!offers || offers.length === 0) {
      await db
        .update(volumesTable)
        .set({ status: "error", statusMessage: "No GPU offers available to provision volume", updatedAt: new Date() })
        .where(eq(volumesTable.id, volumeRecord.id));
      res.status(503).json({ error: "No GPU offers available to provision volume" });
      return;
    }

    const selectedOffer = offers[0] as { id: number };

    // Step 4: Build a minimal onstart script that just downloads the model and writes status
    const MODEL_REPO = "moonshotai/Kimi-K2.5";
    const MODEL_QUANT = profile.defaultQuant;
    const MODEL_DIR = `/workspace/models/${MODEL_QUANT}`;

    const provisionScript = `#!/bin/bash
set -e
LOG=/var/log/provision.log
echo "starting" > /tmp/instance-status
echo "[$(date)] Starting model download provisioning..." | tee -a $LOG

mkdir -p "${MODEL_DIR}"

echo "downloading" > /tmp/instance-status
echo "[$(date)] Downloading ${MODEL_REPO}..." | tee -a $LOG
pip3 install -q huggingface-hub
huggingface-cli download "${MODEL_REPO}" \\
  --local-dir "${MODEL_DIR}" \\
  --local-dir-use-symlinks False \\
  --resume-download 2>&1 | tee -a $LOG

echo "[$(date)] Download complete!" | tee -a $LOG
echo "llm_ready" > /tmp/instance-status

# Stay alive for a bit so the dashboard can detect completion
sleep 120
`;

    // Step 5: Create a minimal provisioning instance with the volume mounted
    const result = await vastai.createInstance({
      offerId: selectedOffer.id,
      image: profile.dockerImageTag,
      onstart: provisionScript,
      disk: 50,
      volumeId: vastVolumeId,
      volumeMountPath: "/workspace/models",
      env: {
        MODEL_REPO,
        MODEL_QUANT,
      },
    });

    const instanceId = result.new_contract;

    // Step 6: Update DB with provisioning instance ID
    const [updated] = await db
      .update(volumesTable)
      .set({
        provisioningInstanceId: instanceId,
        statusMessage: "Provisioning instance started — downloading model weights...",
        updatedAt: new Date(),
      })
      .where(eq(volumesTable.id, volumeRecord.id))
      .returning();

    logger.info({ volumeDbId: updated.id, vastVolumeId, instanceId }, "Volume provisioning instance started");

    res.status(201).json({
      ...updated,
      profileName: profile.displayName,
    });
  } catch (err: unknown) {
    logger.error(err, "Failed to create volume");
    const message = err instanceof Error ? err.message : "Unknown error";

    if (volumeDbId !== undefined) {
      await db
        .update(volumesTable)
        .set({ status: "error", statusMessage: `Setup failed: ${message}`, updatedAt: new Date() })
        .where(eq(volumesTable.id, volumeDbId))
        .catch((e) => logger.warn(e, "Failed to mark volume as error"));
    }

    res.status(500).json({ error: `Failed to create volume: ${message}` });
  }
});

// DELETE /volumes/:id — destroy volume and associated Vast.ai volume
router.delete("/volumes/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid volume ID" });
    return;
  }

  const [volume] = await db.select().from(volumesTable).where(eq(volumesTable.id, id));
  if (!volume) {
    res.status(404).json({ error: "Volume not found" });
    return;
  }

  try {
    // Destroy provisioning instance if still running
    if (volume.provisioningInstanceId) {
      try {
        await vastai.destroyInstance(volume.provisioningInstanceId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("404") && !msg.includes("no_such_instance")) {
          logger.warn({ err, instanceId: volume.provisioningInstanceId }, "Failed to destroy provisioning instance");
        }
      }
    }

    // Destroy the Vast.ai volume
    if (volume.vastVolumeId) {
      try {
        await vastai.destroyVolume(volume.vastVolumeId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("404")) {
          logger.warn({ err, vastVolumeId: volume.vastVolumeId }, "Failed to destroy Vast.ai volume (may already be deleted)");
        }
      }
    }

    await db.delete(volumesTable).where(eq(volumesTable.id, id));

    res.json({ success: true });
  } catch (err: unknown) {
    logger.error(err, "Failed to delete volume");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to delete volume: ${message}` });
  }
});

export default router;
