import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, paletteIntentsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

/** Resolved from env at startup — scopes all palette history to this identity. */
const PALETTE_USER_ID = process.env["OMNIQL_MEM_USER_ID"] || "operator";

const VALID_ACTIONS = [
  "navigate",
  "stop-session",
  "reindex-session",
  "new-session",
  "relaunch-session",
  "copy-ssh",
] as const;

type PaletteAction = (typeof VALID_ACTIONS)[number];

/** Actions that require a numeric sessionId in payload */
const SESSION_ACTIONS = new Set<PaletteAction>([
  "stop-session",
  "reindex-session",
  "relaunch-session",
  "copy-ssh",
]);

const SYSTEM_PROMPT = `You are an AI assistant embedded in the FLOATR command palette — a cloud coding platform for managing GPU-backed coding sessions.

Your job is to parse a natural-language command from the user and return a structured JSON action object. The user is currently using the app; use the context provided to resolve ambiguous references like "my session", "the running one", "last night's session", etc.

Available action types:
- navigate: Navigate to a route in the app
  Available routes: "/" (dashboard), "/sessions" (sessions list), "/sessions/{id}" (session detail), "/skills", "/memory", "/templates", "/design-intelligence"
- stop-session: Stop a session. Requires sessionId in payload. Use activeSessionId from context when user says "my session", "the running one", etc. If no active session exists in context, set ok=false.
- reindex-session: Trigger a repo re-index for a session. Requires sessionId in payload.
- new-session: Open the new session launch dialog.
- relaunch-session: Re-launch a stopped session. Requires sessionId in payload.
- copy-ssh: Copy the SSH command for a session. Requires sessionId in payload.

Respond with ONLY valid JSON matching this schema:
{
  "ok": boolean,
  "action": "<action-type>" | null,
  "payload": { "route": "<route>" | null, "sessionId": <number> | null } | null,
  "explanation": "<human-readable description of what will happen, or reason for failure>"
}

Rules:
- If the command is clear and actionable, set ok=true and fill in action+payload.
- If the command references "active session", "running session", or "my session" and there is an activeSessionId in context, use that sessionId.
- If the command references a session by number (e.g. "session 42" or "#42"), use that ID as sessionId.
- If context is needed but not available (e.g. user says "stop my session" but there is no active session), set ok=false and explain why.
- If the command is unrecognizable or outside scope, set ok=false with a friendly explanation.
- Keep explanation concise (≤ 80 chars). It will be shown in a toast notification.
- Never include markdown, code fences, or any text outside the JSON object.`;

/** Number of recent successful intents to include as few-shot examples. */
const FEW_SHOT_LIMIT = 5;

/** Build the few-shot examples block to append to the system prompt. */
function buildFewShotBlock(
  examples: Array<{ query: string; action: string | null; payloadJson: unknown; explanation: string }>
): string {
  if (examples.length === 0) return "";

  const lines = [
    "",
    "Past successful commands from this user (use as few-shot examples):",
  ];
  for (const ex of examples) {
    const payload = ex.payloadJson ?? null;
    lines.push(
      `  User: "${ex.query}" → ${JSON.stringify({ ok: true, action: ex.action, payload, explanation: ex.explanation })}`
    );
  }
  return lines.join("\n");
}

/** Strict server-side validation of the LLM-returned intent payload. */
function validateParsedIntent(parsed: unknown): {
  ok: boolean;
  action: PaletteAction | null;
  payload: { route: string | null; sessionId: number | null } | null;
  explanation: string;
} | null {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)["ok"] !== "boolean" ||
    typeof (parsed as Record<string, unknown>)["explanation"] !== "string"
  ) {
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  const ok = raw["ok"] as boolean;
  const explanation = raw["explanation"] as string;

  if (!ok) {
    return { ok: false, action: null, payload: null, explanation };
  }

  const rawAction = raw["action"];
  if (typeof rawAction !== "string" || !VALID_ACTIONS.includes(rawAction as PaletteAction)) {
    return null;
  }
  const action = rawAction as PaletteAction;

  const rawPayload = raw["payload"] ?? null;
  let route: string | null = null;
  let sessionId: number | null = null;

  if (rawPayload !== null && typeof rawPayload === "object") {
    const p = rawPayload as Record<string, unknown>;
    route = typeof p["route"] === "string" ? p["route"] : null;
    sessionId = typeof p["sessionId"] === "number" ? p["sessionId"] : null;
  }

  // Enforce required fields per action type.
  if (action === "navigate" && typeof route !== "string") {
    return null;
  }
  if (SESSION_ACTIONS.has(action) && typeof sessionId !== "number") {
    return null;
  }

  return { ok: true, action, payload: { route, sessionId }, explanation };
}

/** Persist an intent result (success or failure) to the DB for future learning. */
async function persistIntent(
  userId: string,
  query: string,
  result: { ok: boolean; action: PaletteAction | null; payload: { route: string | null; sessionId: number | null } | null; explanation: string }
): Promise<void> {
  try {
    await db.insert(paletteIntentsTable).values({
      userId,
      query,
      ok: result.ok,
      action: result.action,
      payloadJson: result.payload,
      explanation: result.explanation,
    });
  } catch (err) {
    logger.warn({ err }, "palette-intent: failed to persist intent to DB");
  }
}

router.post("/palette/intent", async (req, res) => {
  const body = req.body as {
    query?: unknown;
    context?: {
      route?: unknown;
      activeSessionId?: unknown;
      activeSessionStatus?: unknown;
      recentSessionIds?: unknown;
    };
  };

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 500) {
    res.status(400).json({ error: "query must be a non-empty string (max 500 chars)" });
    return;
  }

  const context = body?.context ?? {};
  const route = typeof context.route === "string" ? context.route : "/";
  const activeSessionId =
    typeof context.activeSessionId === "number" ? context.activeSessionId : null;
  const activeSessionStatus =
    typeof context.activeSessionStatus === "string" ? context.activeSessionStatus : null;
  const recentSessionIds = Array.isArray(context.recentSessionIds)
    ? (context.recentSessionIds as unknown[]).filter((x): x is number => typeof x === "number")
    : [];

  const userMessage = [
    `User query: "${query}"`,
    "",
    "Current context:",
    `  route: ${route}`,
    `  activeSessionId: ${activeSessionId ?? "none"}`,
    `  activeSessionStatus: ${activeSessionStatus ?? "none"}`,
    `  recentSessionIds: [${recentSessionIds.join(", ")}]`,
  ].join("\n");

  try {
    // Fetch this user's recent successful intents to use as few-shot examples.
    // Filtered by PALETTE_USER_ID so no cross-user data leaks into the prompt.
    let fewShotBlock = "";
    try {
      const recentSuccessful = await db
        .select({
          query: paletteIntentsTable.query,
          action: paletteIntentsTable.action,
          payloadJson: paletteIntentsTable.payloadJson,
          explanation: paletteIntentsTable.explanation,
        })
        .from(paletteIntentsTable)
        .where(and(
          eq(paletteIntentsTable.userId, PALETTE_USER_ID),
          eq(paletteIntentsTable.ok, true)
        ))
        .orderBy(desc(paletteIntentsTable.createdAt))
        .limit(FEW_SHOT_LIMIT);

      fewShotBlock = buildFewShotBlock(recentSuccessful);
    } catch (err) {
      logger.warn({ err }, "palette-intent: failed to load few-shot examples from DB");
    }

    // Lazy import so missing AI env vars only fail this handler, not server startup.
    const { openai } = await import("@workspace/integrations-openai-ai-server");

    const systemPrompt = fewShotBlock ? SYSTEM_PROMPT + fewShotBlock : SYSTEM_PROMPT;

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";

    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(raw);
    } catch {
      logger.warn({ raw }, "palette-intent: LLM returned non-JSON response");
      const failResult = {
        ok: false as const,
        action: null,
        payload: null,
        explanation: "Could not parse command — please try rephrasing",
      };
      void persistIntent(PALETTE_USER_ID, query, failResult);
      res.json(failResult);
      return;
    }

    const validated = validateParsedIntent(rawParsed);
    if (validated === null) {
      logger.warn({ rawParsed }, "palette-intent: LLM returned invalid action/payload schema");
      const failResult = {
        ok: false as const,
        action: null,
        payload: null,
        explanation: "Unexpected response format — please try rephrasing",
      };
      void persistIntent(PALETTE_USER_ID, query, failResult);
      res.json(failResult);
      return;
    }

    void persistIntent(PALETTE_USER_ID, query, validated);
    res.json(validated);
  } catch (err) {
    logger.error({ err }, "palette-intent: LLM call failed");
    res.status(500).json({ error: "Failed to resolve command" });
  }
});

export default router;
