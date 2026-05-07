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
      return {
        ...base,
        laneType: laneType as LaneType,
        description: custom.description || `Custom lane type: ${custom.name}`,
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
