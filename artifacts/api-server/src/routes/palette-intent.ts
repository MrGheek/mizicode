import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, paletteIntentsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  renderPaletteIntent,
  PaletteIntentInputSchema,
  PALETTE_INTENT_VERSION,
} from "../prompts/contracts";
import { callLlm } from "../services/llm-client";

const router = Router();

/** Resolved from env at startup — scopes all palette history to this identity. */
const PALETTE_USER_ID = process.env["MIZI_MEM_USER_ID"] || "operator";

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

/** Number of recent successful intents to include as few-shot examples. */
const FEW_SHOT_LIMIT = 5;

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

  try {
    // Fetch this user's recent successful intents to use as few-shot examples.
    // Filtered by PALETTE_USER_ID so no cross-user data leaks into the prompt.
    let fewShotExamples: Array<{
      query: string;
      action: string | null;
      payloadJson: unknown;
      explanation: string;
    }> = [];
    try {
      fewShotExamples = await db
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
    } catch (err) {
      logger.warn({ err }, "palette-intent: failed to load few-shot examples from DB");
    }

    // Build the validated contract input and render messages via contracts.ts.
    const contractInput = PaletteIntentInputSchema.parse({
      query,
      context: { route, activeSessionId, activeSessionStatus, recentSessionIds },
      fewShotExamples,
    });
    const messages = renderPaletteIntent(contractInput);

    // Route through the shared callLlm client so promptVersion is recorded
    // uniformly alongside every LLM call (success, failure, and no-provider paths).
    logger.debug(
      { promptVersion: PALETTE_INTENT_VERSION, userId: PALETTE_USER_ID, fewShotCount: fewShotExamples.length },
      "palette-intent: calling LLM",
    );

    const rawOrNull = await callLlm({
      messages,
      max_tokens: 512,
      temperature: 0,
      overrideModel: "meta/llama-3.1-8b-instruct",
      promptVersion: PALETTE_INTENT_VERSION,
      logTag: "palette.intent",
    });

    const raw = rawOrNull?.trim() ?? "";

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
