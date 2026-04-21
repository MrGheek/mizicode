import crypto from "crypto";
import { db, skillsTable, skillBundlesTable, skillVersionsTable, skillSourcesTable, sessionSkillsTable, sessionsTable } from "@workspace/db";
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
  const rawRequestedIds = bundleData.skillIds || [];

  // Normalize: map any DB slugs in skillIds to their manifest IDs.
  // Bundles may be created with DB slugs (e.g. "imported-{source}-{name}") rather than manifest IDs.
  // We fetch the latest manifest for each slug-keyed skill and resolve to manifest.id.
  const dbSkillsBySlug = rawRequestedIds.length > 0
    ? await db
        .select({ slug: skillsTable.slug })
        .from(skillsTable)
        .leftJoin(skillVersionsTable, eq(skillVersionsTable.skillId, skillsTable.id))
        .where(inArray(skillsTable.slug, rawRequestedIds))
    : [];

  // Build a resolved manifest-ID set: start with raw IDs, then replace DB slugs with manifest IDs
  const resolvedManifests = await getAllEnabledManifests();
  const manifestIdBySlug = new Map<string, string>(
    resolvedManifests.map(m => [
      // Map both manifest.id and DB slug (if the skill was imported with a derived slug)
      m.id, m.id,
    ])
  );
  // Also map DB slug → manifest.id for imported skills (slug = "imported-{src}-{manifestId}")
  for (const row of dbSkillsBySlug) {
    if (row.slug && !manifestIdBySlug.has(row.slug)) {
      // Try to find a manifest whose ID matches the tail portion of the slug
      const tail = row.slug.replace(/^imported-\d+-/, "");
      const matched = resolvedManifests.find(m => m.id === tail || m.id === row.slug);
      if (matched) manifestIdBySlug.set(row.slug, matched.id);
    }
  }

  const requestedIds = rawRequestedIds.map(rid => manifestIdBySlug.get(rid) ?? rid);

  // Deduplicate by manifest.id: DB manifests take precedence over built-in defaults
  // (allows updated seeded skills to override the embedded DEFAULT_SKILLS copy)
  const manifestsById = new Map<string, FloatrSkillManifest>();
  for (const s of DEFAULT_SKILLS.filter(s => requestedIds.includes(s.id))) {
    manifestsById.set(s.id, s);
  }
  for (const s of resolvedManifests.filter(s => requestedIds.includes(s.id))) {
    manifestsById.set(s.id, s); // DB version wins if duplicate
  }
  const allManifests = Array.from(manifestsById.values());

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

  // ── Step 2: Fill remaining slots up to maxSkills, enforcing conflict resolution ──
  const selected: FloatrSkillManifest[] = [...mandatory];
  let tokenBudget = selected.reduce((sum, s) => sum + s.cost.tokenOverheadEstimate, 0);

  for (const manifest of remaining) {
    if (selected.length >= maxSkills) break;
    if (tokenBudget + manifest.cost.tokenOverheadEstimate > maxTokenBudget) continue;
    // Conflict check: same class + overlapping triggers → skip (higher-scored mandatory already present)
    const hasConflict = selected.some(
      s => s.class === manifest.class &&
           s.id !== manifest.id &&
           s.triggers.tasks.some(t => manifest.triggers.tasks.includes(t))
    );
    if (hasConflict) continue;
    selected.push(manifest);
    tokenBudget += manifest.cost.tokenOverheadEstimate;
  }

  // ── Step 3: Guarantee mandatory class coverage (doctrine + workflow) ──
  // The bundle's requestedIds may not include a doctrine or workflow; inject from defaults.
  const selectedIds = () => new Set(selected.map(s => s.id));

  if (!selected.some(s => s.class === "doctrine")) {
    const ranked = rankSkills(DEFAULT_SKILLS.filter(s => s.class === "doctrine"), ctx);
    const ids = selectedIds();
    const fallback = ranked.find(r => !ids.has(r.manifest.id));
    if (fallback) selected.push(fallback.manifest);
  }

  if (!selected.some(s => s.class === "workflow")) {
    const ranked = rankSkills(DEFAULT_SKILLS.filter(s => s.class === "workflow"), ctx);
    const ids = selectedIds();
    const fallback = ranked.find(r => !ids.has(r.manifest.id));
    if (fallback) selected.push(fallback.manifest);
  }

  // ── Step 4: If still below minimum, add from all default skills regardless of requestedIds ──
  if (selected.length < MIN_SKILLS) {
    const fallbackRanked = rankSkills(DEFAULT_SKILLS, ctx);
    const ids = selectedIds();
    for (const { manifest } of fallbackRanked) {
      if (selected.length >= MIN_SKILLS) break;
      if (!ids.has(manifest.id)) {
        selected.push(manifest);
        ids.add(manifest.id);
        tokenBudget += manifest.cost.tokenOverheadEstimate;
      }
    }
  }

  // ── Step 5: Hard cap — always 3–7 skills, preserving doctrine+workflow guarantees ──
  if (selected.length > MAX_SKILLS) {
    // Keep doctrine and workflow anchors; trim excess from the tail (lower-scored)
    const anchors = selected.filter(s => s.class === "doctrine" || s.class === "workflow");
    const rest = selected.filter(s => s.class !== "doctrine" && s.class !== "workflow");
    const slotsForRest = MAX_SKILLS - anchors.length;
    const trimmed = [...anchors, ...rest.slice(0, Math.max(slotsForRest, 0))];
    selected.length = 0;
    trimmed.forEach(s => selected.push(s));
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
    activatedSkillsJson: compiled.skills as unknown as Record<string, unknown>[],
    rationaleJson: compiled.reasoning as unknown as Record<string, unknown>,
    tokenMode,
    activationMode: "boot",
  });
}

export async function seedDefaultSkills(): Promise<void> {
  // Ensure floatr-native skill source exists
  let [nativeSource] = await db
    .select({ id: skillSourcesTable.id })
    .from(skillSourcesTable)
    .where(eq(skillSourcesTable.repoUrl, "https://github.com/floatr/skills"));

  if (!nativeSource) {
    [nativeSource] = await db
      .insert(skillSourcesTable)
      .values({
        repoUrl: "https://github.com/floatr/skills",
        sourceType: "builtin",
        trustLevel: "floatr_native",
      })
      .returning({ id: skillSourcesTable.id });
  }

  const existing = await db.select({ slug: skillsTable.slug }).from(skillsTable);
  const existingSlugs = new Set(existing.map(s => s.slug));

  for (const manifest of DEFAULT_SKILLS) {
    if (existingSlugs.has(manifest.id)) continue;

    const [skill] = await db
      .insert(skillsTable)
      .values({
        slug: manifest.id,
        name: manifest.name,
        class: manifest.class,
        description: manifest.summary,
        sourceId: nativeSource.id,
        trustTier: manifest.source.trust,
        installRisk: manifest.install.type,
        tokenOverheadEstimate: manifest.cost.tokenOverheadEstimate,
        enabled: true,
        reviewStatus: "approved",
        reviewedAt: new Date(),
      })
      .returning();

    const versionHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex")
      .slice(0, 16);

    await db.insert(skillVersionsTable).values({
      skillId: skill.id,
      manifestJson: manifest as unknown as Record<string, unknown>,
      versionHash,
    });

    logger.info({ slug: manifest.id, skillId: skill.id }, "Seeded default skill");
  }
}

export async function seedDefaultBundles(): Promise<void> {
  // Seed skills first so bundles can reference them
  await seedDefaultSkills();

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

export async function getDefaultBundleForContext(
  ctx: SessionContext,
  hasRepoContext = false,
): Promise<typeof skillBundlesTable.$inferSelect | null> {
  const all = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.isDefault, true));
  if (all.length === 0) return null;

  // Spec: when repo context is absent, always fall back to floatr-builder (generic safe default)
  if (!hasRepoContext) {
    const builder = all.find(b => b.slug === "floatr-builder");
    if (builder) return builder;
    // If floatr-builder not present yet, fall through to context scoring
  }

  // Context-scored selection when repo context is available
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
