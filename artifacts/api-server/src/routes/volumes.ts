import { Router } from "express";
import { db, volumesTable, gpuProfilesTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import * as vastai from "../services/vastai";
import type { VastOffer } from "../services/vastai";
import { logger } from "../lib/logger";

const router = Router();

type VolumeRow = typeof volumesTable.$inferSelect & { profileName?: string | null };

/**
 * Sync a single provisioning volume against Vast.ai and update the DB.
 * Returns the (possibly updated) merged record.
 */
async function syncProvisioningVolume(volume: VolumeRow): Promise<VolumeRow> {
  if (volume.status !== "provisioning" || !volume.provisioningInstanceId) {
    return volume;
  }

  try {
    const instance = await vastai.getInstance(volume.provisioningInstanceId);
    const vastStatus = instance.actual_status || "";
    const statusMsg = (instance.status_msg || "").toLowerCase();

    let newStatus = volume.status;
    let newMessage = volume.statusMessage;
    let clearInstanceId = false;

    if (vastStatus === "running") {
      if (statusMsg.includes("llm_ready") || statusMsg.includes("ready")) {
        newStatus = "ready";
        newMessage = "Model weights cached — volume ready";
        clearInstanceId = true;
        // Destroy the provisioning instance — model is downloaded
        try {
          await vastai.destroyInstance(volume.provisioningInstanceId);
          logger.info({ instanceId: volume.provisioningInstanceId, volumeId: volume.id }, "Provisioning instance destroyed after successful download");
        } catch {
          logger.warn({ instanceId: volume.provisioningInstanceId }, "Failed to destroy provisioning instance after download");
        }
      } else if (statusMsg.includes("downloading")) {
        newMessage = "Downloading model weights to volume...";
      } else if (statusMsg.includes("starting") || statusMsg.includes("running")) {
        newMessage = "Instance running — starting download...";
      }
    } else if (vastStatus === "loading" || vastStatus === "creating") {
      newMessage = "Provisioning instance starting up...";
    } else if (vastStatus === "exited" || vastStatus === "error") {
      newStatus = "error";
      newMessage = `Provisioning failed: ${instance.status_msg || vastStatus}`;
      clearInstanceId = true;
    }

    const hasChanges =
      newStatus !== volume.status ||
      newMessage !== volume.statusMessage ||
      clearInstanceId;

    if (hasChanges) {
      const updateSet: Partial<VolumeRow> & { updatedAt: Date } = {
        status: newStatus,
        statusMessage: newMessage,
        updatedAt: new Date(),
        ...(clearInstanceId ? { provisioningInstanceId: null } : {}),
      };
      const [updated] = await db
        .update(volumesTable)
        .set(updateSet)
        .where(eq(volumesTable.id, volume.id))
        .returning();
      return { ...updated, profileName: volume.profileName };
    }
  } catch (err) {
    logger.warn({ err, volumeId: volume.id }, "Failed to sync volume provisioning status from Vast.ai");
  }

  return volume;
}

// GET /volumes — list all volumes, syncing any that are provisioning
// The dashboard polls this endpoint via useListVolumes, so we do Vast.ai sync here
// to ensure volumes transition to `ready` and are visible to the session creation flow.
router.get("/volumes", async (_req, res) => {
  const rows = await db
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

  // Sync all provisioning volumes against Vast.ai in parallel
  const synced = await Promise.all(
    rows.map(row =>
      row.status === "provisioning" && row.provisioningInstanceId
        ? syncProvisioningVolume(row as VolumeRow)
        : row
    )
  );

  res.json(synced);
});

// GET /volumes/:id — get a single volume (also syncs provisioning status)
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

  const synced = await syncProvisioningVolume(volume as VolumeRow);
  res.json(synced);
});

// POST /volumes — create a Vast.ai volume and start a provisioning instance
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

  // Check for existing volume records for this profile
  const existingRecords = await db
    .select()
    .from(volumesTable)
    .where(eq(volumesTable.profileId, profileId))
    .orderBy(desc(volumesTable.createdAt));

  const activeVolume = existingRecords.find(v => v.status !== "error");
  if (activeVolume) {
    res.status(409).json({
      error: `A volume already exists for this profile (status: ${activeVolume.status}). Delete it first to set up a new one.`,
    });
    return;
  }

  // Clean up any error-state records for this profile before creating a fresh one
  const errorRecords = existingRecords.filter(v => v.status === "error");
  for (const errRecord of errorRecords) {
    // Destroy the old Vast.ai volume if it exists
    if (errRecord.vastVolumeId) {
      await vastai.destroyVolume(errRecord.vastVolumeId).catch(() => {});
    }
    if (errRecord.provisioningInstanceId) {
      await vastai.destroyInstance(errRecord.provisioningInstanceId).catch(() => {});
    }
    await db.delete(volumesTable).where(eq(volumesTable.id, errRecord.id)).catch(() => {});
  }

  const volumeName = name || `omniql-${profile.name}-models`;
  const volumeSizeGb = sizeGb || Math.max(profile.quantSizeGb + 50, 300);

  let volumeDbId: number | undefined;

  try {
    logger.info({ profileId, volumeName, volumeSizeGb }, "Creating Vast.ai volume");
    const vastVolume = await vastai.createVolume(volumeName, volumeSizeGb);
    const vastVolumeId = vastVolume.id!;

    const [volumeRecord] = await db
      .insert(volumesTable)
      .values({
        profileId,
        vastVolumeId,
        name: volumeName,
        status: "provisioning",
        sizeGb: volumeSizeGb,
        statusMessage: "Volume created — finding GPU to download model weights...",
      })
      .returning();

    volumeDbId = volumeRecord.id;

    const searchParams = (profile.searchParams as Record<string, unknown>) || {};
    const offers = await vastai.searchOffers({
      gpu_name: searchParams.gpu_name as string,
      num_gpus: (searchParams.num_gpus as number) || 1,
      min_gpu_ram: searchParams.min_gpu_ram as number,
      disk_space: 50,
      limit: 5,
    });

    if (!offers || offers.length === 0) {
      await db
        .update(volumesTable)
        .set({ status: "error", statusMessage: "No GPU offers available to provision volume", updatedAt: new Date() })
        .where(eq(volumesTable.id, volumeRecord.id));
      res.status(503).json({ error: "No GPU offers available to provision volume. Try again later." });
      return;
    }

    const selectedOffer = offers[0] as VastOffer;
    const MODEL_REPO = "moonshotai/Kimi-K2.5";
    const MODEL_QUANT = profile.defaultQuant;
    const MODEL_DIR = `/workspace/models/${MODEL_QUANT}`;

    const provisionScript = `#!/bin/bash
set -e
LOG=/var/log/provision.log
echo "starting" > /tmp/instance-status
echo "[$(date)] Starting model download provisioning for ${MODEL_REPO}..." | tee -a $LOG

pip3 install -q huggingface-hub 2>&1 | tee -a $LOG

mkdir -p "${MODEL_DIR}"

echo "[$(date)] Downloading ${MODEL_REPO} → ${MODEL_DIR}..." | tee -a $LOG
echo "downloading" > /tmp/instance-status

huggingface-cli download "${MODEL_REPO}" \\
  --local-dir "${MODEL_DIR}" \\
  --local-dir-use-symlinks False \\
  --resume-download 2>&1 | tee -a $LOG

echo "[$(date)] Download complete! Verifying..." | tee -a $LOG
ls -lh "${MODEL_DIR}" | tee -a $LOG

echo "llm_ready" > /tmp/instance-status
echo "[$(date)] Volume provisioning done — model cached at ${MODEL_DIR}" | tee -a $LOG

# Stay alive for 3 minutes so the dashboard can poll and detect completion
sleep 180
`;

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

    const [updated] = await db
      .update(volumesTable)
      .set({
        provisioningInstanceId: instanceId,
        statusMessage: "Provisioning instance started — downloading model weights (~15-30 min)...",
        updatedAt: new Date(),
      })
      .where(eq(volumesTable.id, volumeRecord.id))
      .returning();

    logger.info({ volumeDbId: updated.id, vastVolumeId, instanceId }, "Volume provisioning instance started");

    res.status(201).json({ ...updated, profileName: profile.displayName });
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

// DELETE /volumes/:id — destroy volume and Vast.ai resources
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
    if (volume.provisioningInstanceId) {
      await vastai.destroyInstance(volume.provisioningInstanceId).catch((err) => {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("404") && !msg.includes("no_such_instance")) {
          logger.warn({ err, instanceId: volume.provisioningInstanceId }, "Failed to destroy provisioning instance");
        }
      });
    }

    if (volume.vastVolumeId) {
      await vastai.destroyVolume(volume.vastVolumeId).catch((err) => {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("404")) {
          logger.warn({ err, vastVolumeId: volume.vastVolumeId }, "Failed to destroy Vast.ai volume");
        }
      });
    }

    await db.delete(volumesTable).where(eq(volumesTable.id, id));

    res.json({ success: true });
  } catch (err: unknown) {
    logger.error(err, "Failed to delete volume");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to delete volume: ${message}` });
  }
});

export { syncProvisioningVolume };
export default router;
