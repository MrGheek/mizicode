import crypto from "crypto";
import { db, skillsTable, skillBundlesTable, skillVersionsTable, sessionSkillsTable, sessionsTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { DEFAULT_SKILLS, DEFAULT_BUNDLES } from "./default-skills";
import { rankSkills } from "./skills-ranker";
import { TOKEN_MODE_PROFILES } from "./skills-types";
import type { FloatrSkillManifest, SessionContext, CompiledBundle, TokenMode } from "./skills-types";
import { logger } from "../lib/logger";

async function getAllEnabledManifests(): Promise<FloatrSkillManifest[]> {
  const enabledSkills = await db
    .select({ id: skillsTable.id })
    .from(skillsTable)
    .where(and(eq(skillsTable.enabled, true), eq(skillsTable.reviewStatus, "approved")));

  if (enabledSkills.length === 0) return [];

  const versions = await db
    .select()
    .from(skillVersionsTable)
    .where(inArray(skillVersionsTable.skillId, enabledSkills.map(s => s.id)))
    .orderBy(desc(skillVersionsTable.createdAt));

  // Keep only the latest version per skill (first encountered after DESC sort)
  const bySkillId = new Map<number, typeof versions[0]>();
  for (const v of versions) {
    if (!bySkillId.has(v.skillId)) bySkillId.set(v.skillId, v);
  }

  return Array.from(bySkillId.values())
    .map(v => v.manifestJson as unknown as FloatrSkillManifest)
    .filter(Boolean);
}

const MIN_SKILLS = 3;
const MAX_SKILLS = 7;

export async function compileBundle(bundleId: number, ctx: SessionContext): Promise<CompiledBundle> {
  const [bundle] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, bundleId));
  if (!bundle) throw new Error(`Bundle ${bundleId} not found`);

  const bundleData = bundle.bundleJson as { skillIds?: string[] };
  const requestedIds = bundleData.skillIds || [];

  const allManifests = [
    ...DEFAULT_SKILLS.filter(s => requestedIds.includes(s.id)),
    ...(await getAllEnabledManifests()).filter(s => requestedIds.includes(s.id)),
  ];

  const tokenProfile = TOKEN_MODE_PROFILES[ctx.tokenMode];
  const maxSkills = Math.min(tokenProfile.activeSkillCountLimit, MAX_SKILLS);
  const maxTokenBudget = Math.floor(tokenProfile.maxContextBudget * 0.05);

  const ranked = rankSkills(allManifests, ctx);

  // ── Step 1: Reserve mandatory slots for doctrine + workflow coverage ──
  const mandatory: FloatrSkillManifest[] = [];
  const remaining: FloatrSkillManifest[] = [];

  const hasDoctrine = () => mandatory.some(s => s.class === "doctrine");
  const hasWorkflow = () => mandatory.some(s => s.class === "workflow");

  for (const { manifest } of ranked) {
    if (!hasDoctrine() && manifest.class === "doctrine") {
      mandatory.push(manifest);
    } else if (!hasWorkflow() && manifest.class === "workflow") {
      mandatory.push(manifest);
    } else {
      remaining.push(manifest);
    }
  }

  // ── Step 2: Fill remaining slots up to maxSkills ──
  const selected: FloatrSkillManifest[] = [...mandatory];
  let tokenBudget = selected.reduce((sum, s) => sum + s.cost.tokenOverheadEstimate, 0);

  for (const manifest of remaining) {
    if (selected.length >= maxSkills) break;
    if (tokenBudget + manifest.cost.tokenOverheadEstimate > maxTokenBudget) continue;
    selected.push(manifest);
    tokenBudget += manifest.cost.tokenOverheadEstimate;
  }

  // ── Step 3: If still below minimum, add from all default skills regardless of requestedIds ──
  if (selected.length < MIN_SKILLS) {
    const fallbackRanked = rankSkills(DEFAULT_SKILLS, ctx);
    const selectedIds = new Set(selected.map(s => s.id));
    for (const { manifest } of fallbackRanked) {
      if (selected.length >= MIN_SKILLS) break;
      if (!selectedIds.has(manifest.id)) {
        selected.push(manifest);
        selectedIds.add(manifest.id);
        tokenBudget += manifest.cost.tokenOverheadEstimate;
      }
    }
  }

  return {
    bundleId,
    slug: bundle.slug,
    name: bundle.name,
    skills: selected,
    reasoning: {
      task: `taskMode=${ctx.taskMode}`,
      repo: `repoLangs=[${ctx.repoLangs.join(",")}]`,
      model: `modelProfile=${ctx.modelProfile}`,
      tokenMode: `tokenMode=${ctx.tokenMode}, budget=${tokenBudget}/${maxTokenBudget} tokens, skills=${selected.length}`,
    },
  };
}

export function buildSystemPromptFragment(compiled: CompiledBundle, tokenMode: TokenMode): string {
  const profile = TOKEN_MODE_PROFILES[tokenMode];
  const lines: string[] = [];
  lines.push(`<!-- FLOATR Smart Skills — bundle: ${compiled.slug}, tokenMode: ${tokenMode} -->`);
  lines.push(`${profile.responseStyleDirective}`);
  lines.push("");

  for (const skill of compiled.skills) {
    lines.push(`<!-- Skill: ${skill.name} (${skill.class}) -->`);
    for (const rule of skill.instructions.system) {
      lines.push(`- ${rule}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function buildActiveBundleEnvPayload(compiled: CompiledBundle, tokenMode: TokenMode): string {
  const payload = {
    bundleSlug: compiled.slug,
    tokenMode,
    skills: compiled.skills.map(s => ({
      id: s.id,
      name: s.name,
      class: s.class,
      instructions: s.instructions.system,
    })),
    systemPromptFragment: buildSystemPromptFragment(compiled, tokenMode),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export async function recordSessionActivation(sessionId: number, compiled: CompiledBundle, tokenMode: TokenMode): Promise<void> {
  await db.insert(sessionSkillsTable).values({
    sessionId,
    bundleId: compiled.bundleId,
    activatedSkillsJson: compiled.skills.map(s => s.id) as unknown as Record<string, unknown>,
    rationaleJson: compiled.reasoning as unknown as Record<string, unknown>,
    tokenMode,
    activationMode: "boot",
  });
}

export async function seedDefaultBundles(): Promise<void> {
  const existing = await db.select({ slug: skillBundlesTable.slug }).from(skillBundlesTable);
  const existingSlugs = new Set(existing.map(b => b.slug));

  for (const spec of DEFAULT_BUNDLES) {
    if (existingSlugs.has(spec.slug)) continue;

    await db.insert(skillBundlesTable).values({
      slug: spec.slug,
      name: spec.name,
      bundleJson: { skillIds: spec.skillIds } as unknown as Record<string, unknown>,
      taskMode: spec.taskMode,
      sessionMode: spec.sessionMode,
      tokenMode: "core",
      isDefault: true,
    });
    logger.info({ slug: spec.slug }, "Seeded default bundle");
  }
}

export async function getDefaultBundleForContext(ctx: SessionContext): Promise<typeof skillBundlesTable.$inferSelect | null> {
  const all = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.isDefault, true));
  if (all.length === 0) return null;

  const scored = all.map(b => {
    let score = 0;
    if (b.taskMode === ctx.taskMode) score += 2;
    if (b.sessionMode === ctx.sessionType) score += 1;
    return { bundle: b, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.bundle || null;
}

export function extractRepoFingerprint(repoFingerprintJson: unknown): {
  langs: string[];
  repoKind: string | null;
} {
  if (!repoFingerprintJson || typeof repoFingerprintJson !== "object") {
    return { langs: [], repoKind: null };
  }
  const fp = repoFingerprintJson as Record<string, unknown>;
  return {
    langs: Array.isArray(fp.langs) ? (fp.langs as string[]) : [],
    repoKind: typeof fp.repoKind === "string" ? fp.repoKind : null,
  };
}
