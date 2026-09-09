#!/usr/bin/env -S npx tsx
/**
 * real-llm-e2e.ts — RFC 0001/0002 real-model verification against Ollama Cloud
 *
 * Runs the actual production prompt + pipeline code against a real LLM
 * (Ollama Cloud), with real token counts. Requires:
 *   OLLAMA_API_KEY   — Ollama Cloud key (or artifacts/api-server/.env.local)
 *   OLLAMA_BASE_URL  — https://ollama.com (defaults to that for the cloud path)
 *
 * Exercises:
 *   1. callLlm + renderPlanGenerate  → parse GeneratedPlan JSON
 *   2. callLlm + renderPlanReassess → parse status array
 *   3. callLlm + renderPlanDecompose → parse candidate array
 *   4. arbitrateConflict (intent-reconstructed, test-verified) → proposal
 *   5. createDefaultCorrectnessJudge → 0..1 score
 *
 * Exit 0 when every stage produces a parseable result; 1 otherwise.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Load gitignored .env.local (artifacts/api-server/.env.local) if present.
// Script lives at src/tests/e2e/ → up 3 = artifacts/api-server/.
const envLocal = path.join(here, "..", "..", "..", ".env.local");
if (fs.existsSync(envLocal)) {
  const lines = fs.readFileSync(envLocal, "utf-8").split("\n");
  for (const l of lines) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
  }
}

process.env["OLLAMA_BASE_URL"] = process.env["OLLAMA_BASE_URL"] || "https://ollama.com";

const MODEL = process.env["REAL_LLM_MODEL"] || "gemma4:31b";

function ok(name: string, detail: string): void {
  console.log(`  ✓ ${name} — ${detail}`);
}
function fail(name: string, err: unknown): never {
  console.error(`  ✗ ${name} — ${String(err).slice(0, 300)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!process.env["OLLAMA_API_KEY"]) {
    console.error("Missing OLLAMA_API_KEY (set it or provide artifacts/api-server/.env.local)");
    process.exit(1);
  }
  console.log(`Real-LLM E2E against Ollama Cloud (${MODEL})\n`);

  // ── 1. plan.generate ──────────────────────────────────────────────────────
  console.log("1. plan.generate");
  const { callLlm } = await import("../../services/llm-client.js");
  const { renderPlanGenerate } = await import("../../prompts/contracts.js");
  try {
    const raw = await callLlm({
      messages: renderPlanGenerate({
        intentText: "Add a session-scoped audit trail that records every tool call with who triggered it",
      }),
      temperature: 0.2,
      max_tokens: 1600,
      promptVersion: "plan.generate@1.1.0",
      logTag: "real.e2e.plan.generate",
      overrideModel: MODEL,
    });
    if (!raw) return fail("plan.generate", "no output");
    const json = raw.match(/\{[\s\S]*\}s?/)?.[0];
    const parsed = json ? JSON.parse(json) as { title?: string; steps?: unknown[] } : null;
    if (!parsed?.title || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return fail("plan.generate", `malformed: ${raw.slice(0, 150)}`);
    }
    ok("plan.generate", `title="${parsed.title.slice(0, 40)}" steps=${parsed.steps.length}`);
  } catch (err) { return fail("plan.generate", err); }

  // ── 2. plan.reassess ──────────────────────────────────────────────────────
  console.log("2. plan.reassess");
  const { renderPlanReassess } = await import("../../prompts/contracts.js");
  try {
    const raw = await callLlm({
      messages: renderPlanReassess({
        tasks: [
          { id: 1, text: "Design audit_trail schema", status: "in_progress", confirmedByUser: true },
          { id: 2, text: "Instrument tool runner", status: "planned", confirmedByUser: false },
        ],
        observations: [{ toolName: "grep", inputSummary: "audit", outputSummary: "3 refs" }],
      }),
      temperature: 0,
      max_tokens: 500,
      promptVersion: "plan.reassess@1.1.0",
      logTag: "real.e2e.plan.reassess",
      overrideModel: MODEL,
    });
    if (!raw) return fail("plan.reassess", "no output");
    const json = raw.match(/\[[\s\S]*\]/)?.[0] ?? null;
    const parsed = json ? JSON.parse(json) as unknown[] : null;
    if (!Array.isArray(parsed)) return fail("plan.reassess", `not array: ${raw.slice(0, 150)}`);
    ok("plan.reassess", `entries=${parsed.length}`);
  } catch (err) { return fail("plan.reassess", err); }

  // ── 3. plan.decompose ─────────────────────────────────────────────────────
  console.log("3. plan.decompose");
  const { renderPlanDecompose } = await import("../../prompts/contracts.js");
  try {
    const raw = await callLlm({
      messages: renderPlanDecompose({
        existingTasks: [{ text: "Add audit table", status: "in_progress" }],
        recentObservations: [{ toolName: "test", inputSummary: "audit", outputSummary: "2 passed 1 failed (actor filter)" }],
        activeSkills: [{ name: "backend", tasks: ["build", "test"] }],
        rationaleContext: "",
        maxCandidates: 3,
      }),
      temperature: 0.2,
      max_tokens: 700,
      promptVersion: "plan.decompose@1.1.0",
      logTag: "real.e2e.plan.decompose",
      overrideModel: MODEL,
    });
    if (!raw) return fail("plan.decompose", "no output");
    const json = raw.match(/\[[\s\S]*\]/)?.[0] ?? null;
    const parsed = json ? JSON.parse(json) as unknown[] : null;
    if (!Array.isArray(parsed)) return fail("plan.decompose", `not array: ${raw.slice(0, 150)}`);
    ok("plan.decompose", `candidates=${parsed.length}`);
  } catch (err) { return fail("plan.decompose", err); }

  // ── 4. Arbiter ────────────────────────────────────────────────────────────
  console.log("4. lane.arbiter (intent-reconstructed)");
  const { arbitrateConflict, createDefaultArbiterLlm } = await import("../../services/lane-arbiter.js");
  try {
    const llm = createDefaultArbiterLlm();
    // Wrap so we override the model and disable test verification (no repo here).
    const llmOverride: typeof llm = async (messages) => {
      const content = await callLlm({
        messages,
        temperature: 0,
        max_tokens: 900,
        promptVersion: "lane.arbiter@1.0.0",
        logTag: "real.e2e.lane.arbiter",
        overrideModel: MODEL,
        budget: { taskClass: "plan-reassess" },
      });
      return content;
    };
    const result = await arbitrateConflict(
      {
        filePath: "src/auth/UserIdentity.ts",
        baseContent: "export class UserIdentity { userId: string }",
        laneA: { laneId: 1, content: "export class UserIdentity { userId: string; oauthProvider!: string }" },
        laneB: { laneId: 2, content: "export class UserIdentity { userId: string; role!: string }" },
        intentEvents: [
          { id: 1, sessionId: 1, laneId: 1, eventType: "intent_interface_change", summary: "Add OAuth provider identity", file: "src/auth/UserIdentity.ts", contract: "UserIdentity(oauthProvider)", risk: null, evidence: null, createdAt: new Date() },
          { id: 2, sessionId: 1, laneId: 2, eventType: "intent_interface_change", summary: "Add authorization role", file: "src/auth/UserIdentity.ts", contract: "UserIdentity(role)", risk: null, evidence: null, createdAt: new Date() },
        ],
      },
      { llm: llmOverride, testGate: { run: async () => ({ passed: true, output: "" }) }, git: { writeFile: async () => true }, skipTestVerify: true },
      "/repo",
    );
    if (!result.accepted || !result.proposal) return fail("lane.arbiter", `not accepted: ${result.reason}`);
    ok("lane.arbiter", `outcome=${result.proposal.outcome} resolution_len=${result.proposal.resolution.length}`);
  } catch (err) { return fail("lane.arbiter", err); }

  // ── 5. Judge ──────────────────────────────────────────────────────────────
  console.log("5. lane-eval judge");
  const { createDefaultCorrectnessJudge } = await import("../../services/lane-eval.js");
  try {
    const judge = createDefaultCorrectnessJudge();
    const j = await judge({
      goal: "Add OAuth + authorization roles",
      acceptanceCriteria: ["OAuth works", "roles enforced"],
      output: "export class UserIdentity { userId; oauthProvider; role }",
    });
    if (typeof j.score !== "number" || j.score < 0 || j.score > 1) return fail("lane-eval judge", `bad score: ${j.score}`);
    ok("lane-eval judge", `score=${j.score.toFixed(2)} summary="${j.summary.slice(0, 60)}"`);
  } catch (err) { return fail("lane-eval judge", err); }

  console.log("\nAll real-LLM stages passed against Ollama Cloud.");
}

main().catch((err) => fail("main", err));