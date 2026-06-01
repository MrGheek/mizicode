import crypto from "crypto";
import { db, skillsTable, skillSourcesTable, skillBundlesTable, skillVersionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";

export const ECC_REPO_URL = "https://github.com/affaan-m/ECC";
export const ECC_BUNDLE_SLUG = "ecc-essentials";
export const ECC_BUNDLE_NAME = "ECC Essentials";

/**
 * Curated set of ECC manifest IDs to approve as the "ECC Essentials" bundle.
 *
 * Selection criteria:
 *  - installRisk must be "virtual" (instruction-only, no Node.js hooks required)
 *  - meaningful instruction content (≥3 extracted bullets)
 *  - covers domains not already in MIZI's built-in default skill catalog
 *
 * These are the skill directory names from the ECC repo (skills/<name>/SKILL.md).
 * The importer sets the manifest ID to the directory name, and the DB slug to
 * `imported-{sourceId}-{manifestId}`, so we extract the manifestId from the slug
 * when matching.
 */
export const ECC_ESSENTIALS_MANIFEST_IDS = new Set([
  "tdd-workflow",
  "security-review",
  "api-design",
  "backend-patterns",
  "frontend-patterns",
  "autonomous-loops",
  "dmux-workflows",
  "continuous-learning",
  "architecture-decision-records",
  "code-tour",
  "browser-qa",
  "eval-harness",
  "cost-aware-llm-pipeline",
  "context-management",
  "refactoring-patterns",
  "testing-patterns",
  "documentation-patterns",
  "error-handling",
  "performance-patterns",
  "database-patterns",
  "deployment-patterns",
  "observability-patterns",
  "ai-coding-assistant",
  "prompt-engineering",
  "code-review-patterns",
]);

export async function getEccSource(): Promise<typeof skillSourcesTable.$inferSelect | null> {
  const [source] = await db
    .select()
    .from(skillSourcesTable)
    .where(eq(skillSourcesTable.repoUrl, ECC_REPO_URL));
  return source ?? null;
}

export interface SeedEccResult {
  sourceId: number;
  totalImported: number;
  essentialsFound: number;
  approvedCount: number;
  alreadyApproved: number;
  skippedHighRisk: number;
  bundleId: number;
  bundleCreated: boolean;
}

/**
 * Approve the curated ECC essentials set and create/update the "ECC Essentials" bundle.
 *
 * Idempotent: safe to call multiple times. Skills already approved are left unchanged.
 * High-risk skills (hooked/binary) are never approved regardless of manifest ID match.
 *
 * @throws if the ECC source has not been imported yet.
 */
export async function seedEccEssentials(): Promise<SeedEccResult> {
  const source = await getEccSource();
  if (!source) {
    throw new Error(
      "ECC source not found in DB. Import it first via POST /api/skills/import with url=https://github.com/affaan-m/ECC"
    );
  }

  const eccSkills = await db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.sourceId, source.id));

  const prefix = `imported-${source.id}-`;

  let approvedCount = 0;
  let alreadyApproved = 0;
  let skippedHighRisk = 0;
  const essentialSkills: typeof eccSkills = [];

  for (const skill of eccSkills) {
    const manifestId = skill.slug.startsWith(prefix)
      ? skill.slug.slice(prefix.length)
      : skill.slug;

    if (!ECC_ESSENTIALS_MANIFEST_IDS.has(manifestId)) continue;

    if (skill.installRisk === "hooked" || skill.installRisk === "binary") {
      skippedHighRisk++;
      continue;
    }

    essentialSkills.push(skill);

    if (skill.reviewStatus === "approved" && skill.enabled) {
      alreadyApproved++;
      continue;
    }

    await db
      .update(skillsTable)
      .set({
        reviewStatus: "approved",
        enabled: true,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(skillsTable.id, skill.id));
    approvedCount++;
  }

  const skillSlugs = essentialSkills.map(s => s.slug);

  const [existingBundle] = await db
    .select({ id: skillBundlesTable.id })
    .from(skillBundlesTable)
    .where(eq(skillBundlesTable.slug, ECC_BUNDLE_SLUG));

  let bundleId: number;
  let bundleCreated = false;

  if (existingBundle) {
    await db
      .update(skillBundlesTable)
      .set({
        bundleJson: { skillIds: skillSlugs } as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(skillBundlesTable.id, existingBundle.id));
    bundleId = existingBundle.id;
  } else {
    const [bundle] = await db
      .insert(skillBundlesTable)
      .values({
        slug: ECC_BUNDLE_SLUG,
        name: ECC_BUNDLE_NAME,
        bundleJson: { skillIds: skillSlugs } as unknown as Record<string, unknown>,
        taskMode: null,
        sessionMode: null,
        tokenMode: "core",
        isDefault: false,
      })
      .returning();
    bundleId = bundle.id;
    bundleCreated = true;
  }

  logger.info(
    {
      sourceId: source.id,
      totalImported: eccSkills.length,
      essentialsFound: essentialSkills.length,
      approvedCount,
      alreadyApproved,
      skippedHighRisk,
      bundleId,
      bundleCreated,
    },
    "ECC Essentials catalog seeded"
  );

  return {
    sourceId: source.id,
    totalImported: eccSkills.length,
    essentialsFound: essentialSkills.length,
    approvedCount,
    alreadyApproved,
    skippedHighRisk,
    bundleId,
    bundleCreated,
  };
}
