/**
 * Lane Policy Service
 *
 * Defines overlay bundles, retrieval emphasis, token mode defaults, and conflict
 * escalation rules for each lane type. Each overlay is injected per-lane only —
 * never session-wide. The session core is the only layer shared across all lanes.
 */

import type { LaneType, ClaimType } from "@workspace/db";
import { db, customLaneTypesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const LANE_DEFAULT_TTL_SECONDS = 3600; // 1 hour claim expiry by default
export const LANE_HEARTBEAT_WINDOW_SECONDS = 300; // claims expire if no heartbeat in 5 min

export interface LanePolicyLimits {
  maxConcurrentClaims: number;
  heavyJobSlots: number;
  maxBlastRadiusFiles: number;
  claimTtlSeconds: number;
}

export interface LaneOverlayPolicy {
  laneType: LaneType;
  defaultTaskMode: string;
  defaultTokenMode: string;
  allowedClaimTypes: ClaimType[];
  limits: LanePolicyLimits;
  sharedMemoryScopes: string[];
  privateMemoryScopes: string[];
  // Extended fields (not part of public OpenAPI contract but useful internally)
  defaultOverlaySkillIds: string[];
  retrievalEmphasis: string[];
  conflictEscalation: "warn" | "block";
  description: string;
  /**
   * Design intelligence categories to inject for this lane type.
   * Teams can override this per bundle via bundleJson.designCategoryOverrides[laneType].
   * An empty array means no design context is injected for this lane.
   */
  designCategories: string[];
}

export const LANE_POLICIES: Record<LaneType, LaneOverlayPolicy> = {
  ux: {
    laneType: "ux",
    defaultTaskMode: "build",
    defaultTokenMode: "core",
    allowedClaimTypes: ["file", "module", "symbol"],
    limits: {
      maxConcurrentClaims: 20,
      heavyJobSlots: 1,
      maxBlastRadiusFiles: 30,
      claimTtlSeconds: LANE_DEFAULT_TTL_SECONDS,
    },
    sharedMemoryScopes: ["repo_shared", "session_core"],
    privateMemoryScopes: ["lane_user"],
    defaultOverlaySkillIds: ["karpathy-doctrine", "flow-router", "lean-compression", "design-intelligence-core", "ui-ux-reasoning"],
    retrievalEmphasis: ["component", "style", "layout", "ui", "frontend", "design", "palette", "typography"],
    conflictEscalation: "warn",
    description: "UX/frontend lane — emphasises component and style context, warns on overlap with backend lanes.",
    designCategories: ["palette", "typography", "chart_type", "ux_guideline", "ui_reasoning", "anti_pattern", "style"],
  },
  debug: {
    laneType: "debug",
    defaultTaskMode: "debug",
    defaultTokenMode: "core",
    allowedClaimTypes: ["file", "symbol", "task"],
    limits: {
      maxConcurrentClaims: 10,
      heavyJobSlots: 2,
      maxBlastRadiusFiles: 50,
      claimTtlSeconds: LANE_DEFAULT_TTL_SECONDS,
    },
    sharedMemoryScopes: ["repo_shared", "session_core"],
    privateMemoryScopes: ["lane_user", "task"],
    defaultOverlaySkillIds: ["debug-flow", "checkpoints-lite", "compact-response"],
    retrievalEmphasis: ["error", "stack", "trace", "exception", "failure"],
    conflictEscalation: "warn",
    description: "Debug lane — structured debug workflow, compact output, warns on claim overlap.",
    designCategories: [],
  },
  backend: {
    laneType: "backend",
    defaultTaskMode: "build",
    defaultTokenMode: "full",
    allowedClaimTypes: ["file", "module", "symbol", "task"],
    limits: {
      maxConcurrentClaims: 30,
      heavyJobSlots: 3,
      maxBlastRadiusFiles: 100,
      claimTtlSeconds: LANE_DEFAULT_TTL_SECONDS,
    },
    sharedMemoryScopes: ["repo_shared", "session_core", "user_operator"],
    privateMemoryScopes: ["lane_user", "task"],
    defaultOverlaySkillIds: ["karpathy-doctrine", "flow-router", "memory-governance-core"],
    retrievalEmphasis: ["api", "service", "database", "schema", "migration"],
    conflictEscalation: "warn",
    description: "Backend lane — fuller context budget, governance memory, shared API conventions.",
    designCategories: ["stack_convention"],
  },
  review: {
    laneType: "review",
    defaultTaskMode: "review",
    defaultTokenMode: "lean",
    allowedClaimTypes: ["file", "module", "task"],
    limits: {
      maxConcurrentClaims: 15,
      heavyJobSlots: 1,
      maxBlastRadiusFiles: 40,
      claimTtlSeconds: LANE_DEFAULT_TTL_SECONDS,
    },
    sharedMemoryScopes: ["repo_shared", "session_core"],
    privateMemoryScopes: ["lane_user"],
    defaultOverlaySkillIds: ["karpathy-doctrine", "one-line-review", "focused-memory", "frontend-design-review", "design-handoff-discipline"],
    retrievalEmphasis: ["pr", "review", "diff", "convention", "test"],
    conflictEscalation: "warn",
    description: "Review lane — lean token mode, terse output, focuses on conventions and test coverage.",
    designCategories: ["ux_guideline", "anti_pattern"],
  },
  general: {
    laneType: "general",
    defaultTaskMode: "build",
    defaultTokenMode: "core",
    allowedClaimTypes: ["file", "module", "symbol", "task"],
    limits: {
      maxConcurrentClaims: 20,
      heavyJobSlots: 2,
      maxBlastRadiusFiles: 50,
      claimTtlSeconds: LANE_DEFAULT_TTL_SECONDS,
    },
    sharedMemoryScopes: ["repo_shared", "session_core"],
    privateMemoryScopes: ["lane_user", "task"],
    defaultOverlaySkillIds: ["karpathy-doctrine", "flow-router", "memory-compact"],
    retrievalEmphasis: [],
    conflictEscalation: "warn",
    description: "General-purpose lane — balanced defaults, no specific retrieval emphasis.",
    designCategories: ["palette", "typography", "stack_convention", "ux_guideline"],
  },
};

export const VALID_LANE_TYPES: LaneType[] = ["ux", "debug", "backend", "review", "general"];
export const BUILTIN_LANE_TYPE_NAMES: string[] = ["ux", "debug", "backend", "review", "general"];

export function getLanePolicy(laneType: string): LaneOverlayPolicy {
  return LANE_POLICIES[laneType as LaneType] ?? LANE_POLICIES.general;
}

/**
 * Async version of getLanePolicy that also checks the custom_lane_types table.
 * Custom lane types inherit the "general" overlay bundle but use their own limits.
 */
export async function getLanePolicyAsync(laneType: string): Promise<LaneOverlayPolicy> {
  const builtin = LANE_POLICIES[laneType as LaneType];
  if (builtin) return builtin;

  try {
    const [custom] = await db
      .select()
      .from(customLaneTypesTable)
      .where(eq(customLaneTypesTable.name, laneType))
      .limit(1);

    if (custom) {
      const base = { ...LANE_POLICIES.general };
      const overlaySkillIds = Array.isArray(custom.overlaySkillIdsJson)
        ? (custom.overlaySkillIdsJson as string[])
        : base.defaultOverlaySkillIds;
      const retrievalEmphasis = Array.isArray(custom.retrievalEmphasisJson)
        ? (custom.retrievalEmphasisJson as string[])
        : base.retrievalEmphasis;
      const designCategories = Array.isArray(custom.designCategoriesJson)
        ? (custom.designCategoriesJson as string[])
        : base.designCategories;
      const defaultTokenMode =
        typeof custom.policyTokenMode === "string"
          ? custom.policyTokenMode
          : base.defaultTokenMode;
      return {
        ...base,
        laneType: laneType as LaneType,
        description: custom.description || `Custom lane type: ${custom.name}`,
        defaultTokenMode,
        defaultOverlaySkillIds: overlaySkillIds,
        retrievalEmphasis,
        designCategories,
        limits: {
          ...base.limits,
          maxConcurrentClaims: custom.maxConcurrentClaims,
          heavyJobSlots: custom.heavyJobSlots,
        },
      };
    }
  } catch {
    // Fall through to general if DB query fails
  }

  return LANE_POLICIES.general;
}

/**
 * Validate whether a given lane type string is a valid built-in or custom type.
 * Returns the resolved lane type name (may be the same string if custom, or "general" fallback).
 */
export async function resolveValidLaneType(laneType: string | undefined): Promise<string> {
  if (!laneType) return "general";
  if (BUILTIN_LANE_TYPE_NAMES.includes(laneType)) return laneType;

  try {
    const [custom] = await db
      .select({ name: customLaneTypesTable.name })
      .from(customLaneTypesTable)
      .where(eq(customLaneTypesTable.name, laneType))
      .limit(1);
    if (custom) return custom.name;
  } catch {
    // Fall through
  }

  return "general";
}

/**
 * Compute an overlap confidence score [0, 1] between two sets of claimed paths/symbols.
 * Returns 0 if no overlap, higher scores for more overlap.
 */
export function computeClaimOverlap(
  claimsA: string[],
  claimsB: string[],
): number {
  if (claimsA.length === 0 || claimsB.length === 0) return 0;
  const setA = new Set(claimsA.map(c => c.toLowerCase()));
  const setB = new Set(claimsB.map(c => c.toLowerCase()));

  let directOverlap = 0;
  for (const a of setA) {
    if (setB.has(a)) directOverlap++;
  }

  // Also check for prefix/parent-directory overlaps (e.g., src/api/ overlaps src/api/routes.ts)
  let prefixOverlap = 0;
  for (const a of setA) {
    for (const b of setB) {
      if (a !== b && (b.startsWith(a + "/") || a.startsWith(b + "/"))) {
        prefixOverlap++;
      }
    }
  }

  const totalA = setA.size;
  const score = (directOverlap + prefixOverlap * 0.5) / totalA;
  return Math.min(1.0, score);
}

/**
 * Estimate blast-radius overlap between two lane claim sets using repo graph edges.
 * Returns a score [0, 1] indicating how likely cross-lane interference is via transitive dependencies.
 */
export function estimateBlastRadiusOverlap(
  claimsA: string[],
  claimsB: string[],
  repoEdges: Array<{ from: string; to: string }>,
): number {
  if (repoEdges.length === 0 || claimsA.length === 0 || claimsB.length === 0) return 0;

  const setA = new Set(claimsA.map(c => c.toLowerCase()));
  const setB = new Set(claimsB.map(c => c.toLowerCase()));

  let blastHits = 0;
  for (const edge of repoEdges) {
    const fromNorm = edge.from.toLowerCase();
    const toNorm = edge.to.toLowerCase();
    if ((setA.has(fromNorm) && setB.has(toNorm)) || (setB.has(fromNorm) && setA.has(toNorm))) {
      blastHits++;
    }
  }

  const maxPossible = Math.max(claimsA.length, claimsB.length);
  return Math.min(1.0, blastHits / maxPossible);
}

// ─── Symbol-level conflict detection ──────────────────────────────────────────

/**
 * A claim enriched with optional symbol metadata.
 * When `symbols` is present and non-empty, the claim targets specific functions/classes
 * within the file at `pathOrSymbol`. Claims without `symbols` fall back to file-level
 * overlap detection.
 */
export interface ClaimWithSymbols {
  pathOrSymbol: string;
  symbols?: string[] | null;
}

/**
 * Result from symbol-aware overlap computation.
 */
export interface SymbolOverlapResult {
  /** Overlap confidence score [0, 1]. 0 means no conflict. */
  score: number;
  /** File paths that are in conflict at the path level. */
  conflictingResources: string[];
  /** Symbol names that directly collide between the two lanes. */
  conflictingSymbols: string[];
}

/**
 * Compute overlap between two enriched claim sets using symbol metadata where available.
 *
 * Resolution order for a pair of claims sharing the same file path:
 *  1. If both claims carry `symbols`, only flag a conflict when their symbol sets intersect.
 *  2. If either claim lacks `symbols`, fall back to the existing file-path overlap logic.
 *
 * This eliminates false positives when two lanes edit distinct, non-overlapping functions
 * in the same file.
 */
export function computeSymbolAwareClaimOverlap(
  claimsA: ClaimWithSymbols[],
  claimsB: ClaimWithSymbols[],
): SymbolOverlapResult {
  if (claimsA.length === 0 || claimsB.length === 0) {
    return { score: 0, conflictingResources: [], conflictingSymbols: [] };
  }

  const conflictingResources: string[] = [];
  const conflictingSymbols: string[] = [];

  // Deduplicate into sets keyed by normalised path — mirrors computeClaimOverlap's setA/setB.
  // When the same path appears multiple times we keep the claim with the richest symbol set
  // (most symbols), which is the safest choice for conflict detection.
  const mapA = new Map<string, ClaimWithSymbols>();
  for (const c of claimsA) {
    const key = c.pathOrSymbol.toLowerCase();
    const existing = mapA.get(key);
    if (!existing || (c.symbols?.length ?? 0) > (existing.symbols?.length ?? 0)) {
      mapA.set(key, c);
    }
  }
  const mapB = new Map<string, ClaimWithSymbols>();
  for (const c of claimsB) {
    const key = c.pathOrSymbol.toLowerCase();
    const existing = mapB.get(key);
    if (!existing || (c.symbols?.length ?? 0) > (existing.symbols?.length ?? 0)) {
      mapB.set(key, c);
    }
  }

  // Score accumulators mirror computeClaimOverlap exactly:
  //   score = (directOverlap + prefixOverlap * 0.5) / setA.size, capped at 1.0
  let directOverlap = 0;
  let prefixOverlap = 0;

  for (const [keyA, claimA] of mapA) {
    if (mapB.has(keyA)) {
      // Direct path match — apply symbol-level refinement when both sides have symbols.
      const claimB = mapB.get(keyA)!;
      const symbolsA = claimA.symbols?.filter(Boolean) ?? [];
      const symbolsB = claimB.symbols?.filter(Boolean) ?? [];

      if (symbolsA.length > 0 && symbolsB.length > 0) {
        // Both symbol-scoped: only conflict when symbol sets intersect
        const symSetA = new Set(symbolsA.map(s => s.toLowerCase()));
        const collisions = symbolsB.filter(s => symSetA.has(s.toLowerCase()));

        if (collisions.length > 0) {
          for (const sym of collisions) {
            if (!conflictingSymbols.includes(sym)) conflictingSymbols.push(sym);
          }
          if (!conflictingResources.includes(claimA.pathOrSymbol)) {
            conflictingResources.push(claimA.pathOrSymbol);
          }
          directOverlap++;
        }
        // No collision → different symbols in the same file → NOT a conflict; contribute 0
      } else {
        // At least one side lacks symbol metadata — file-level fallback (full weight)
        if (!conflictingResources.includes(claimA.pathOrSymbol)) {
          conflictingResources.push(claimA.pathOrSymbol);
        }
        directOverlap++;
      }
    } else {
      // No direct match — check for prefix/directory overlap with 0.5 weight,
      // exactly as computeClaimOverlap does.
      for (const keyB of mapB.keys()) {
        if (keyB !== keyA && (keyB.startsWith(keyA + "/") || keyA.startsWith(keyB + "/"))) {
          if (!conflictingResources.includes(claimA.pathOrSymbol)) {
            conflictingResources.push(claimA.pathOrSymbol);
          }
          prefixOverlap++;
          break; // count once per distinct path from A
        }
      }
    }
  }

  const totalA = mapA.size;
  const score = Math.min(1.0, (directOverlap + prefixOverlap * 0.5) / totalA);
  return { score, conflictingResources, conflictingSymbols };
}

/**
 * A blast-radius triggering edge annotated with optional symbol-level caller/callee info.
 */
export interface AnnotatedBlastEdge {
  /** File path of the caller. */
  fromPath: string;
  /** File path of the callee. */
  toPath: string;
  /** Symbol in `fromPath` that calls into `toPath`, if known. */
  callerSymbol?: string;
  /** Symbol in `toPath` that is called, if known. */
  calleeSymbol?: string;
}

/**
 * Result from annotated blast-radius overlap computation.
 */
export interface BlastRadiusAnnotatedResult {
  /** Score [0, 1] — same semantics as estimateBlastRadiusOverlap. */
  score: number;
  /** Edges in the dependency graph that triggered the blast-radius warning. */
  triggeringEdges: AnnotatedBlastEdge[];
}

/**
 * Estimate blast-radius overlap with edge-level annotations for UI display.
 * Returns a score AND the specific dependency edges (caller → callee) that
 * triggered the warning, so the dashboard can show "funcA in file.ts imports
 * into other.ts" rather than a generic file-level warning.
 *
 * `repoEdges` may optionally carry `fromSymbol`/`toSymbol` fields to enable
 * symbol-level edge gating. When an edge carries `fromSymbol`/`toSymbol` AND
 * the corresponding claim side provides a symbols list, the edge is only
 * counted when the edge symbol appears in the claimed symbols for that file.
 * This prevents blast-radius warnings from firing when two lanes work on
 * different symbols in the same file and a call-graph edge exists between them
 * for unrelated functions.
 */
export function estimateBlastRadiusOverlapAnnotated(
  claimsA: ClaimWithSymbols[],
  claimsB: ClaimWithSymbols[],
  repoEdges: Array<{ from: string; to: string; fromSymbol?: string; toSymbol?: string }>,
): BlastRadiusAnnotatedResult {
  if (repoEdges.length === 0 || claimsA.length === 0 || claimsB.length === 0) {
    return { score: 0, triggeringEdges: [] };
  }

  // Build path → claimed symbol set lookups for fine-grained symbol gating.
  // Only paths whose claims carry at least one symbol are entered; paths without
  // symbol metadata skip symbol gating and rely on file-path matching alone.
  const symbolsForPathA = new Map<string, Set<string>>();
  for (const c of claimsA) {
    if (c.symbols && c.symbols.length > 0) {
      symbolsForPathA.set(c.pathOrSymbol.toLowerCase(), new Set(c.symbols.map(s => s.toLowerCase())));
    }
  }
  const symbolsForPathB = new Map<string, Set<string>>();
  for (const c of claimsB) {
    if (c.symbols && c.symbols.length > 0) {
      symbolsForPathB.set(c.pathOrSymbol.toLowerCase(), new Set(c.symbols.map(s => s.toLowerCase())));
    }
  }

  const setA = new Set(claimsA.map(c => c.pathOrSymbol.toLowerCase()));
  const setB = new Set(claimsB.map(c => c.pathOrSymbol.toLowerCase()));

  let blastHits = 0;
  const triggeringEdges: AnnotatedBlastEdge[] = [];

  /**
   * Check whether a directional interpretation of the edge passes symbol gating.
   * Returns true when the edge should be counted for this direction.
   */
  const passesSymbolGating = (
    e: { fromSymbol?: string; toSymbol?: string },
    fromNorm: string,
    toNorm: string,
    callerSide: "A" | "B",
  ): boolean => {
    if (e.fromSymbol) {
      const callerSyms = callerSide === "A"
        ? symbolsForPathA.get(fromNorm)
        : symbolsForPathB.get(fromNorm);
      if (callerSyms && !callerSyms.has(e.fromSymbol.toLowerCase())) {
        return false;
      }
    }
    if (e.toSymbol) {
      const calleeSyms = callerSide === "A"
        ? symbolsForPathB.get(toNorm)
        : symbolsForPathA.get(toNorm);
      if (calleeSyms && !calleeSyms.has(e.toSymbol.toLowerCase())) {
        return false;
      }
    }
    return true;
  };

  for (const edge of repoEdges) {
    const fromNorm = edge.from.toLowerCase();
    const toNorm = edge.to.toLowerCase();

    // Evaluate both possible directional interpretations independently.
    // This is critical for same-file edges (from === to) or when a file is
    // claimed by both lanes: the first branch should not shadow the second.
    // An edge is counted when AT LEAST ONE valid interpretation passes
    // symbol gating (but counted only once per edge regardless).
    const aCallerValid = setA.has(fromNorm) && setB.has(toNorm) && passesSymbolGating(edge, fromNorm, toNorm, "A");
    const bCallerValid = setB.has(fromNorm) && setA.has(toNorm) && passesSymbolGating(edge, fromNorm, toNorm, "B");

    if (!aCallerValid && !bCallerValid) continue;

    blastHits++;
    triggeringEdges.push({
      fromPath: edge.from,
      toPath: edge.to,
      callerSymbol: edge.fromSymbol,
      calleeSymbol: edge.toSymbol,
    });
  }

  const maxPossible = Math.max(claimsA.length, claimsB.length);
  const score = Math.min(1.0, blastHits / maxPossible);
  return { score, triggeringEdges };
}
