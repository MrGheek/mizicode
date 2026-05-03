import { Router } from "express";
import { db, schedulerConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

const RESERVED_NAMES = new Set(["__shared__", "owner", "admin", "root", "shared"]);
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function sanitizeMemberName(raw: string): string | null {
  const cleaned = String(raw).trim().toLowerCase();
  if (!SAFE_NAME_RE.test(cleaned)) return null;
  if (RESERVED_NAMES.has(cleaned)) return null;
  return cleaned;
}

function sanitizeTeamMemberNames(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const name = sanitizeMemberName(String(item));
    if (name && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
    if (result.length >= 4) break;
  }
  return result;
}

const router = Router();

async function getOrCreateConfig() {
  const [existing] = await db.select().from(schedulerConfigTable).limit(1);
  if (existing) return existing;

  const [created] = await db.insert(schedulerConfigTable).values({}).returning();
  return created;
}

router.get("/scheduler", async (_req, res) => {
  try {
    const config = await getOrCreateConfig();
    res.json(config);
  } catch (err) {
    logger.error(err, "Failed to get scheduler config");
    res.status(500).json({ error: "Failed to get scheduler config" });
  }
});

router.put("/scheduler", async (req, res) => {
  try {
    const {
      enabled,
      profileId,
      launchTime,
      stopTime,
      secondReminderTime,
      daysOfWeek,
      timezone,
      teamMemberNames,
      repoUrl,
    } = req.body;

    const config = await getOrCreateConfig();

    const updates: Partial<typeof schedulerConfigTable.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (enabled !== undefined) updates.enabled = enabled;
    if (profileId !== undefined) updates.profileId = profileId;
    if (launchTime !== undefined) updates.launchTime = launchTime;
    if (stopTime !== undefined) updates.stopTime = stopTime;
    if (secondReminderTime !== undefined) updates.secondReminderTime = secondReminderTime;
    if (daysOfWeek !== undefined) updates.daysOfWeek = daysOfWeek;
    if (timezone !== undefined) updates.timezone = timezone;
    if (Array.isArray(teamMemberNames)) updates.teamMemberNames = sanitizeTeamMemberNames(teamMemberNames);
    if (repoUrl !== undefined) updates.repoUrl = typeof repoUrl === "string" && repoUrl.trim() ? repoUrl.trim() : null;

    const [updated] = await db
      .update(schedulerConfigTable)
      .set(updates)
      .where(eq(schedulerConfigTable.id, config.id))
      .returning();

    res.json(updated);
  } catch (err) {
    logger.error(err, "Failed to update scheduler config");
    res.status(500).json({ error: "Failed to update scheduler config" });
  }
});

export default router;
