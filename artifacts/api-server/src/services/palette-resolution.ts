/**
 * palette-resolution.ts — Deterministic command resolver for the MIZI palette.
 *
 * RFC 0001 Layer 1 (AVOID): common palette commands are resolved with zero
 * LLM tokens. Only queries that cannot be confidently placed in the closed
 * action schema return null, in which case the caller falls back to the LLM
 * path (renderPaletteIntent → callLlm).
 *
 * The resolver mirrors the same semantics the LLM prompt encodes
 * (prompts/contracts.ts PALETTE_INTENT_SYSTEM): navigate / stop-session /
 * reindex-session / new-session / relaunch-session / copy-ssh, `session N` and
 * `#N` resolve to explicit IDs, and "my/current/active/running session" binds to
 * the activeSessionId from context.
 */

export const PALETTE_ACTIONS = [
  "navigate",
  "stop-session",
  "reindex-session",
  "new-session",
  "relaunch-session",
  "copy-ssh",
] as const;

export type PaletteAction = (typeof PALETTE_ACTIONS)[number];

export interface PaletteContext {
  route: string;
  activeSessionId: number | null;
  activeSessionStatus: string | null;
  recentSessionIds: number[];
}

export interface PaletteIntentResult {
  ok: boolean;
  action: PaletteAction | null;
  payload: { route: string | null; sessionId: number | null } | null;
  explanation: string;
}

/** Actions that require a numeric sessionId in payload. */
export const PALETTE_SESSION_ACTIONS: ReadonlySet<PaletteAction> = new Set<PaletteAction>([
  "stop-session",
  "reindex-session",
  "relaunch-session",
  "copy-ssh",
]);

// ── Route keywords → dashboard route ───────────────────────────────────────────

const ROUTE_KEYWORDS: Array<{ re: RegExp; route: string }> = [
  { re: /\b(dashboard|home|overview|main)\b/, route: "/" },
  { re: /(?:list|show|view|manage|all)\s+sessions|\bsessions\b/, route: "/sessions" },
  { re: /\bskills\b/, route: "/skills" },
  { re: /\b(memory|recall)\b/, route: "/memory" },
  { re: /\btemplates\b/, route: "/templates" },
  { re: /\bdesign[ -]?intelligence\b|\bdesign\b/, route: "/design-intelligence" },
];

// ── Session target extraction ──────────────────────────────────────────────────

/** `session 42`, `session number 42`, `sessions / 42`, or bare `#42`. */
function extractExplicitSessionId(q: string): number | null {
  const patterns = [
    /\b(?:sessions?|session number)\s*#?(\d+)\b/, // "session 42", "session number 42"
    /#(\d+)/, // bare "#42"
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function referencesActive(q: string): boolean {
  return /\b(my|the current|the active|the running|this|that)\s+(one|session)\b/.test(q)
    || /\b(current|active|running|selected)\s+session\b/.test(q)
    || /\brunning one\b/.test(q);
}

function referencesRecent(q: string): boolean {
  return /\b(last|latest|most recent|previous|previous one)\b/.test(q);
}

/**
 * Resolve a close-set identifier from context. Order matches the LLM prompt:
 * explicit numeric claim first, then the active session, then most recent.
 * Returns null when the query asks for a target but none can be pinned.
 */
function resolveSessionId(q: string, ctx: PaletteContext): number | null {
  const explicit = extractExplicitSessionId(q);
  if (explicit !== null) return explicit;
  if (referencesActive(q) && ctx.activeSessionId != null) return ctx.activeSessionId;
  if (referencesRecent(q) && ctx.recentSessionIds.length > 0) {
    // Most recently active session is listed first by the caller.
    return ctx.recentSessionIds[0]!;
  }
  return null;
}

function missingTargetExplanation(action: PaletteAction): string {
  const hints: Record<PaletteAction, string> = {
    "stop-session": "Which session should I stop? Say e.g. \"stop session 3\".",
    "reindex-session": "Which session should I reindex? Say e.g. \"reindex session 3\".",
    "relaunch-session": "Which session should I relaunch? Say e.g. \"relaunch session 3\".",
    "copy-ssh": "Which session's SSH command should I copy? Say e.g. \"copy ssh for session 3\".",
    navigate: "",
    "new-session": "",
  };
  return hints[action] || "I couldn't tell which session you mean.";
}

// ── Main resolver ──────────────────────────────────────────────────────────────

/**
 * Deterministically resolve a palette command, or return null to defer to LLM.
 * Never guesses: unknown verbs/destinations and un-resolvable session targets
 * return null (LLM fallback) rather than a wrong action.
 */
export function resolvePaletteCommandHeuristic(
  query: string,
  ctx: PaletteContext,
): PaletteIntentResult | null {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return null;

  const explicitOrRef = () =>
    referencesActive(q) || referencesRecent(q) || extractExplicitSessionId(q) !== null;

  // Most specific, closed patterns first.
  if (/\b(create|start|new|launch)\s+(a\s+)?(new\s+)?(coding\s+)?session\b/.test(q)) {
    return {
      ok: true,
      action: "new-session",
      payload: { route: null, sessionId: null },
      explanation: "Opening the new session dialog.",
    };
  }

  if (/\bssh\b/.test(q)) {
    const id = resolveSessionId(q, ctx);
    if (id === null) {
      return {
        ok: false,
        action: null,
        payload: null,
        explanation: missingTargetExplanation("copy-ssh"),
      };
    }
    return {
      ok: true,
      action: "copy-ssh",
      payload: { route: null, sessionId: id },
      explanation: `Copying the SSH command for session ${id}.`,
    };
  }

  if (/\bre-?index(?:ing)?\b/.test(q)) {
    const id = resolveSessionId(q, ctx);
    if (id === null) {
      return {
        ok: false,
        action: null,
        payload: null,
        explanation: missingTargetExplanation("reindex-session"),
      };
    }
    return {
      ok: true,
      action: "reindex-session",
      payload: { route: null, sessionId: id },
      explanation: `Re-indexing session ${id}.`,
    };
  }

  if (/\brelaunch|restart|reboot\b/.test(q)) {
    const id = resolveSessionId(q, ctx);
    if (id === null) {
      return {
        ok: false,
        action: null,
        payload: null,
        explanation: missingTargetExplanation("relaunch-session"),
      };
    }
    return {
      ok: true,
      action: "relaunch-session",
      payload: { route: null, sessionId: id },
      explanation: `Relaunching session ${id}.`,
    };
  }

  if (/\b(stop|halt|kill|shut\s?down)\b/.test(q)) {
    const id = resolveSessionId(q, ctx);
    if (id === null) {
      return {
        ok: false,
        action: null,
        payload: null,
        explanation: missingTargetExplanation("stop-session"),
      };
    }
    return {
      ok: true,
      action: "stop-session",
      payload: { route: null, sessionId: id },
      explanation: `Stopping session ${id}.`,
    };
  }

  const navVerb = /\b(open|go (to|into)|show|take me to|navigate|view|switch to)\b/.test(q);
  const sessionRef = explicitOrRef();

  if (navVerb || sessionRef) {
    // A bare `#42` / `session 42` (no verb) means "open that session".
    const sessionId = extractExplicitSessionId(q);
    if (sessionId !== null) {
      return {
        ok: true,
        action: "navigate",
        payload: { route: `/sessions/${sessionId}`, sessionId },
        explanation: `Taking you to session ${sessionId}.`,
      };
    }
    for (const { re, route } of ROUTE_KEYWORDS) {
      if (re.test(q)) {
        return {
          ok: true,
          action: "navigate",
          payload: { route, sessionId: null },
          explanation: `Taking you to ${route}.`,
        };
      }
    }
    // Navigation verb present but destination unparseable → defer to LLM (open
    // vocabulary), rather than guessing.
    return null;
  }

  // Route keywords also resolve standalone ("memory", "skills",
  // "design intelligence") with no navigation verb required.
  for (const { re, route } of ROUTE_KEYWORDS) {
    if (re.test(q)) {
      return {
        ok: true,
        action: "navigate",
        payload: { route, sessionId: null },
        explanation: `Taking you to ${route}.`,
      };
    }
  }

  return null;
}