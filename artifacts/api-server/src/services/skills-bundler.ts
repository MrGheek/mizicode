import crypto from "crypto";
import { db, skillsTable, skillBundlesTable, skillVersionsTable, skillSourcesTable, sessionSkillsTable, sessionsTable, sessionRepoContextTable, designIntelligenceEntriesTable } from "@workspace/db";
import { eq, and, inArray, desc, asc } from "drizzle-orm";
import { DEFAULT_SKILLS, DEFAULT_BUNDLES } from "./default-skills";
import { rankSkills, buildRepoIntelligenceContext, getSkillFeedbackScores, buildHistoryScoresMap, getEvalLiftScoresMap } from "./skills-ranker";
import { TOKEN_MODE_PROFILES } from "./skills-types";
import type { FloatrSkillManifest, SessionContext, CompiledBundle, TokenMode, RepoIntelligenceContext, DesignContextEntry } from "./skills-types";
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

const FRONTEND_LANGS = new Set(["ts", "tsx", "js", "jsx", "svelte", "vue", "css", "html"]);

/**
 * Categories fetched for UX lanes vs. general frontend lanes.
 * UX lanes get the full design doctrine; frontend lanes get a narrower subset.
 */
const UX_LANE_CATEGORIES = [
  "palette",
  "typography",
  "chart_type",
  "ux_guideline",
  "ui_reasoning",
  "anti_pattern",
  "style",
];
const FRONTEND_LANE_CATEGORIES = [
  "palette",
  "typography",
  "stack_convention",
  "ux_guideline",
];

/**
 * Maximum design intelligence entries to inject per token mode.
 * `lean` and `ultra` modes receive no design context (token budget constraint).
 */
const DESIGN_CONTEXT_LIMIT: Partial<Record<TokenMode, number>> = {
  full: 10,
  core: 5,
};

/**
 * Query `design_intelligence_entries` for the given categories and return the
 * top-N entries most relevant to the repo's tech stack, filtered by tag overlap.
 *
 * Filtering rules:
 * - Builds a combined stack-tags set from repoLangs + repoIntelligence.frameworks (if present).
 * - Hard-filters to entries with ≥1 matching tag. Falls back to category-scored entries only
 *   when zero entries pass the hard filter (i.e., the design DB has no stack-specific data).
 * - Fetches all category-matching rows (up to MAX_CANDIDATE_ROWS) so top-N is globally correct.
 * - Skipped entirely for lean/ultra token modes (token budget constraint).
 */
const MAX_CANDIDATE_ROWS = 200;

async function queryDesignIntelligenceContext(
  categories: string[],
  repoLangs: string[],
  tokenMode: TokenMode,
  repoIntelligence?: RepoIntelligenceContext,
): Promise<DesignContextEntry[]> {
  const limit = DESIGN_CONTEXT_LIMIT[tokenMode];
  if (!limit) return [];

  if (categories.length === 0) return [];

  try {
    const rows = await db
      .select({
        category: designIntelligenceEntriesTable.category,
        name: designIntelligenceEntriesTable.name,
        dataJson: designIntelligenceEntriesTable.dataJson,
        tags: designIntelligenceEntriesTable.tags,
      })
      .from(designIntelligenceEntriesTable)
      .where(inArray(designIntelligenceEntriesTable.category, categories))
      .orderBy(asc(designIntelligenceEntriesTable.category), asc(designIntelligenceEntriesTable.id))
      .limit(MAX_CANDIDATE_ROWS);

    if (rows.length === 0) return [];

    // Build comprehensive stack-tag set from both repo langs and detected frameworks.
    const stackTags = new Set([
      ...repoLangs.map(l => l.toLowerCase()),
      ...(repoIntelligence?.frameworks ?? []).map(f => f.toLowerCase()),
    ]);

    const HIGH_PRIORITY = new Set(["ux_guideline", "ui_reasoning", "palette", "typography"]);

    const toEntry = (row: typeof rows[0]) => {
      const tags = (Array.isArray(row.tags) ? row.tags : []) as string[];
      const tagOverlap = tags.filter(t => stackTags.has(t.toLowerCase())).length;
      const categoryBoost = HIGH_PRIORITY.has(row.category) ? 1 : 0;
      return { row, tags, score: tagOverlap * 2 + categoryBoost, tagOverlap };
    };

    const scored = rows.map(toEntry);

    // Hard filter: prefer entries that match at least one stack tag.
    // Fall back to all candidates only when the stack produces zero matches
    // (e.g. design DB has no stack-specific tags, or repoLangs is empty).
    const stackMatched = scored.filter(e => e.tagOverlap > 0);
    const candidates = stackMatched.length > 0 ? stackMatched : scored;

    candidates.sort((a, b) => b.score - a.score);

    return candidates.slice(0, limit).map(({ row, tags }) => ({
      category: row.category,
      name: row.name,
      data: row.dataJson as Record<string, string>,
      tags,
    }));
  } catch (err) {
    logger.warn({ err }, "Failed to query design intelligence context — continuing without it");
    return [];
  }
}

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

  // Inject historical feedback scores and eval lift scores into context if not already present
  let ctxWithHistory = ctx;
  if (!ctx.historyScores) {
    try {
      const feedbackScores = await getSkillFeedbackScores();
      if (feedbackScores.length > 0) {
        ctxWithHistory = { ...ctx, historyScores: buildHistoryScoresMap(feedbackScores) };
      }
    } catch (err) {
      logger.warn({ err }, "Failed to load feedback scores for ranking — continuing without them");
    }
  }

  // Inject eval-based lift scores as a secondary internal ranking signal.
  // Low-confidence eval data is already filtered inside getEvalLiftScoresMap (confidence < 0.30 → no key).
  // This ensures eval signals only influence ranking when there is enough evidence.
  if (!ctxWithHistory.evalLiftScores) {
    try {
      const evalLiftScores = await getEvalLiftScoresMap();
      if (Object.keys(evalLiftScores).length > 0) {
        ctxWithHistory = { ...ctxWithHistory, evalLiftScores };
      }
    } catch (err) {
      logger.warn({ err }, "Failed to load eval lift scores for ranking — continuing without them");
    }
  }

  // Explicit negative-lift suppression: exclude skills with strong measured negative lift
  // from the candidate pool entirely. This is a hard safety rail beyond the soft ranking penalty.
  // Threshold: effectiveLift < -0.1 (after recency decay and penalty factor applied in ranker).
  const SUPPRESSION_LIFT_THRESHOLD = -0.1;
  let suppressed: Set<string> = new Set();
  if (ctxWithHistory.evalLiftScores) {
    suppressed = new Set(
      Object.entries(ctxWithHistory.evalLiftScores)
        .filter(([, lift]) => lift < SUPPRESSION_LIFT_THRESHOLD)
        .map(([slug]) => slug)
    );
    if (suppressed.size > 0) {
      logger.info({ suppressed: [...suppressed] }, "[bundler] Suppressing skills with strong negative eval lift");
    }
  }

  const candidateManifests = suppressed.size > 0
    ? allManifests.filter(m => !suppressed.has(m.id))
    : allManifests;

  const ranked = rankSkills(candidateManifests, ctxWithHistory);

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
    const ranked = rankSkills(DEFAULT_SKILLS.filter(s => s.class === "doctrine"), ctxWithHistory);
    const ids = selectedIds();
    const fallback = ranked.find(r => !ids.has(r.manifest.id));
    if (fallback) selected.push(fallback.manifest);
  }

  if (!selected.some(s => s.class === "workflow")) {
    const ranked = rankSkills(DEFAULT_SKILLS.filter(s => s.class === "workflow"), ctxWithHistory);
    const ids = selectedIds();
    const fallback = ranked.find(r => !ids.has(r.manifest.id));
    if (fallback) selected.push(fallback.manifest);
  }

  // ── Step 4: If still below minimum, add from all default skills regardless of requestedIds ──
  if (selected.length < MIN_SKILLS) {
    const fallbackRanked = rankSkills(DEFAULT_SKILLS, ctxWithHistory);
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

  const intel = ctx.repoIntelligence;
  const repoReasoningParts: string[] = [`repoLangs=[${ctx.repoLangs.join(",")}]`];
  if (intel && intel.confidenceLevel !== "none") {
    repoReasoningParts.push(`confidence=${intel.confidenceLevel}`);
    if (intel.complexityClass) repoReasoningParts.push(`complexity=${intel.complexityClass}`);
    if (intel.monorepo) repoReasoningParts.push("monorepo=true");
    if (intel.isStale) repoReasoningParts.push("stale=true");
  }

  return {
    bundleId,
    slug: bundle.slug,
    name: bundle.name,
    skills: selected,
    reasoning: {
      task: `taskMode=${ctx.taskMode}`,
      repo: repoReasoningParts.join(", "),
      model: `modelProfile=${ctx.modelProfile}`,
      tokenMode: `tokenMode=${ctx.tokenMode}, budget=${tokenBudget}/${maxTokenBudget} tokens, skills=${selected.length}`,
    },
    repoConfidenceLevel: intel?.confidenceLevel || "none",
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

  if (compiled.designContext && compiled.designContext.length > 0) {
    lines.push("<!-- Design System Context (live entries from design intelligence) -->");
    for (const entry of compiled.designContext) {
      const dataStr = Object.entries(entry.data)
        .filter(([, v]) => v && v.trim().length > 0)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      lines.push(`- [${entry.category}] ${entry.name}${dataStr ? ` — ${dataStr}` : ""}`);
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

/**
 * Lane-aware bundle compilation — compiles three tiers per session:
 *   1. session-core bundle (shared across ALL lanes — mandatory)
 *   2. shared-repo bundle (repo graph, architecture summary, conventions — shared)
 *   3. overlay bundle per lane (injected ONLY into that lane's prompt/runtime path)
 *
 * Lane overlays do not override or pollute the session core.
 * The session core is the only layer that crosses lane boundaries.
 */
export interface LaneBundleCompileResult {
  /** Mandatory session-core bundle — shared across ALL lanes. Always compiled first. */
  sessionCoreBundleId: number | null;
  sessionCoreCompiled: CompiledBundle | null;
  /** Shared repo-awareness bundle — injected into every lane as a read-only layer. */
  sharedRepoBundleId: number | null;
  sharedRepoCompiled: CompiledBundle | null;
  /** Per-lane overlay bundles — injected ONLY into their lane's prompt path. */
  laneOverlays: Array<{
    laneId: number;
    memberIdentifier: string;
    laneType: string;
    overlayBundleId: number | null;
    compiled: CompiledBundle | null;
  }>;
}

export async function compileLaneBundles(
  sessionId: number,
  ctx: SessionContext,
  lanes: Array<{ laneId: number; memberIdentifier: string; laneType: string; taskMode?: string; tokenMode?: string }>,
): Promise<LaneBundleCompileResult> {
  const { getLanePolicy } = await import("./lane-policy");

  // Ensure bundles are seeded
  await seedDefaultBundles();

  const all = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.isDefault, true));

  // 1. Session core — always the team coordination bundle (mandatory, shared across ALL lanes)
  const sessionCoreBundle = all.find(b => b.slug === "floatr-team-coordination")
    ?? all.find(b => b.taskMode === "team" && b.sessionMode === "team")
    ?? null;

  // 2. Shared repo bundle — builder bundle as shared read-only baseline
  const sharedRepoBundle = all.find(b => b.slug === "floatr-builder") ?? null;

  // Compile session-core and shared-repo bundles upfront (required by all lanes)
  let sessionCoreCompiled: CompiledBundle | null = null;
  if (sessionCoreBundle) {
    try {
      sessionCoreCompiled = await compileBundle(sessionCoreBundle.id, ctx);
    } catch (err) {
      logger.warn({ err, bundleId: sessionCoreBundle.id }, "Failed to compile session-core bundle");
    }
  }

  let sharedRepoCompiled: CompiledBundle | null = null;
  if (sharedRepoBundle) {
    try {
      sharedRepoCompiled = await compileBundle(sharedRepoBundle.id, ctx);
    } catch (err) {
      logger.warn({ err, bundleId: sharedRepoBundle.id }, "Failed to compile shared-repo bundle");
    }
  }

  const laneOverlays: LaneBundleCompileResult["laneOverlays"] = [];

  for (const lane of lanes) {
    const policy = getLanePolicy(lane.laneType);
    const laneTokenMode = (lane.tokenMode ?? policy.defaultTokenMode) as SessionContext["tokenMode"];
    const laneTaskMode = (lane.taskMode ?? policy.defaultTaskMode) as SessionContext["taskMode"];

    const laneCtx: SessionContext = {
      ...ctx,
      taskMode: laneTaskMode,
      tokenMode: laneTokenMode,
    };

    // Find the best overlay bundle for this lane type
    const overlayBundle = all.find(b => b.taskMode === laneTaskMode && b.sessionMode === "solo")
      ?? all.find(b => b.taskMode === laneTaskMode)
      ?? sharedRepoBundle;

    let compiled: CompiledBundle | null = null;
    if (overlayBundle) {
      try {
        compiled = await compileBundle(overlayBundle.id, laneCtx);
      } catch (err) {
        logger.warn({ err, laneId: lane.laneId, bundleId: overlayBundle.id }, "Failed to compile lane overlay bundle");
      }
    }

    // Conditionally inject dashboard-viz-guidance for general lane when repo has frontend languages
    if (
      lane.laneType === "general" &&
      laneCtx.taskMode === "build" &&
      compiled !== null
    ) {
      const hasFrontend = laneCtx.repoLangs.some(l => FRONTEND_LANGS.has(l.toLowerCase()));
      if (hasFrontend) {
        const vizManifest = DEFAULT_SKILLS.find(s => s.id === "dashboard-viz-guidance");
        const alreadyPresent = compiled.skills.some(s => s.id === "dashboard-viz-guidance");
        if (vizManifest && !alreadyPresent) {
          compiled = { ...compiled, skills: [...compiled.skills, vizManifest] };
          logger.debug({ laneId: lane.laneId }, "Injected dashboard-viz-guidance into general lane overlay");
        }
      }
    }

    // ── Design intelligence injection ──
    // UX lanes always receive the full design doctrine categories.
    // Other lanes with frontend languages detected receive a narrower subset.
    // Injection is skipped entirely for lean/ultra token modes (token budget constraint).
    if (compiled !== null) {
      const isUxLane = lane.laneType === "ux";
      const hasFrontend = laneCtx.repoLangs.some(l => FRONTEND_LANGS.has(l.toLowerCase()));

      if (isUxLane || hasFrontend) {
        const categories = isUxLane ? UX_LANE_CATEGORIES : FRONTEND_LANE_CATEGORIES;
        const designContext = await queryDesignIntelligenceContext(
          categories,
          laneCtx.repoLangs,
          laneCtx.tokenMode,
          laneCtx.repoIntelligence,
        );
        if (designContext.length > 0) {
          compiled = { ...compiled, designContext };
          logger.debug(
            { laneId: lane.laneId, laneType: lane.laneType, entries: designContext.length, tokenMode: laneCtx.tokenMode },
            "Injected design intelligence context into lane bundle",
          );
        }
      }
    }

    laneOverlays.push({
      laneId: lane.laneId,
      memberIdentifier: lane.memberIdentifier,
      laneType: lane.laneType,
      overlayBundleId: overlayBundle?.id ?? null,
      compiled,
    });
  }

  return {
    sessionCoreBundleId: sessionCoreBundle?.id ?? null,
    sessionCoreCompiled,
    sharedRepoBundleId: sharedRepoBundle?.id ?? null,
    sharedRepoCompiled,
    laneOverlays,
  };
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

export async function getRepoIntelligenceForSession(sessionId: number): Promise<RepoIntelligenceContext | undefined> {
  try {
    const [ctx] = await db
      .select()
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .orderBy(desc(sessionRepoContextTable.updatedAt))
      .limit(1);

    if (!ctx) return undefined;
    if (ctx.confidenceLevel === "none") return undefined;

    return buildRepoIntelligenceContext({
      fingerprintJson: ctx.fingerprintJson,
      summaryJson: ctx.summaryJson,
      confidenceLevel: ctx.confidenceLevel,
      isStale: ctx.isStale,
    });
  } catch (err) {
    logger.warn({ err, sessionId }, "Failed to load repo intelligence for session — continuing without it");
    return undefined;
  }
}
