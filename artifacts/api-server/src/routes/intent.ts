import { Router } from "express";
import { listNimModels, getConfiguredProviders, PROVIDER_CONFIG, CATALOG_SWE_BENCH_SCORES } from "../services/nim-catalog";
import { logger } from "../lib/logger";

const router = Router();

// Response path follows the spec contract: "nim" | "gpu" | "choice"
// Repo context is signalled via supplemental `repoSuggestion` on any path.
type IntentPath = "nim" | "gpu" | "choice";
type TaskType = "build" | "review" | "debug" | "refactor" | "explore" | "team";
type ComplexityTier = "quick" | "medium" | "deep";

interface ClassifyRequest {
  intentText?: string;
  repoUrl?: string;
  hasGitHubToken?: boolean;
  availableProviders?: string[];  // client-known configured provider keys
}

interface ProviderLatency {
  key: string;
  latencyMs: number | null;
  live: boolean;
  configured: boolean;
}

async function getProviderLatencies(): Promise<Record<string, ProviderLatency>> {
  const configured = getConfiguredProviders();
  const results = await Promise.allSettled(
    Object.entries(PROVIDER_CONFIG).map(async ([key, info]) => {
      if (!configured[key]) {
        return { key, latencyMs: null, live: false, configured: false };
      }
      const apiKey = process.env[info.envKey];
      const start = Date.now();
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 4000);
        const resp = await fetch(`${info.apiBase}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        clearTimeout(tid);
        const latencyMs = Date.now() - start;
        return { key, latencyMs, live: resp.status < 500, configured: true };
      } catch {
        return { key, latencyMs: null, live: false, configured: true };
      }
    })
  );

  const out: Record<string, ProviderLatency> = {};
  for (const r of results) {
    if (r.status === "fulfilled") out[r.value.key] = r.value;
  }
  return out;
}

const GITHUB_URL_RE = /https?:\/\/(github|gitlab)\.com\/[\w.\-]+\/[\w.\-]+/i;
const REPO_KEYWORD_RE =
  /\b(my repo|existing (repo|project|code|codebase)|working on|add to my|fix in my|in the repo|in my codebase|clone|connect.*repo|pull request|pr review|open pr|my (github|gitlab)|push to|commit to|branch|checkout)\b/i;

function detectsRepoIntent(intentText: string, repoUrl?: string): boolean {
  if (repoUrl) return true;
  return GITHUB_URL_RE.test(intentText) || REPO_KEYWORD_RE.test(intentText);
}

function inferTaskType(intentText: string): TaskType {
  const lower = intentText.toLowerCase();
  if (/\b(team|collab|pair|multi.?user|share)\b/.test(lower)) return "team";
  if (/\b(refactor|restructur|rewrite|migrat|reorgani|clean\s*up)\b/.test(lower)) return "refactor";
  if (/\b(debug|fix|bug|error|broken|crash|fail|not\s*work)\b/.test(lower)) return "debug";
  if (/\b(review|audit|check|assess|analys|critique|quality)\b/.test(lower)) return "review";
  if (/\b(explore|research|investigat|understand|learn|discover|exper)\b/.test(lower)) return "explore";
  return "build";
}

function inferComplexity(intentText: string, repoUrl?: string, taskType?: TaskType): ComplexityTier {
  const lower = intentText.toLowerCase();
  if (taskType === "team") return "deep";
  if (/\b(large|full.?repo|entire|whole|complete|comprehensive|all)\b/.test(lower)) return "deep";
  if (/\b(refactor|restructur|rewrite|migrat)\b/.test(lower)) return "medium";
  if (/\b(quick|simple|small|minor|tiny|just|only|fast)\b/.test(lower)) return "quick";
  if (repoUrl) return "medium";
  return "quick";
}

const TASK_TYPE_WEIGHTS: Record<TaskType, number> = {
  build:   1.0,
  debug:   1.0,
  refactor:0.9,
  explore: 0.7,
  review:  0.6,
  team:    0.5,
};

/** Pick eligible providers, honoring availableProviders client filter if supplied. */
function eligibleProviders(
  model: Awaited<ReturnType<typeof listNimModels>>[number],
  configured: Record<string, boolean>,
  availableProviders?: string[],
): string[] {
  const all = [
    ...(model.nimTypes.includes("nim_type_preview") && configured["nvidia"] ? ["nvidia"] : []),
    ...model.partnerProviders.filter(p => configured[p]),
  ];
  if (availableProviders && availableProviders.length > 0) {
    return all.filter(p => availableProviders.includes(p));
  }
  return all;
}

/** Score a single NIM model across its eligible providers; returns best {score, modelId, provider, latency}. */
function scoreBestProvider(
  model: Awaited<ReturnType<typeof listNimModels>>[number],
  latencies: Record<string, { latencyMs: number | null; live: boolean }>,
  configured: Record<string, boolean>,
  taskWeight: number,
  availableProviders?: string[],
): { score: number; provider: string; latencyMs: number } | null {
  // Use catalog-backed SWE-bench score; fall back to seed map; default 50
  const sweBench = model.sweBenchScore
    ?? CATALOG_SWE_BENCH_SCORES[model.nimModelId]?.score
    ?? 50;
  const providers = eligibleProviders(model, configured, availableProviders);
  let best: { score: number; provider: string; latencyMs: number } | null = null;
  for (const provider of providers) {
    const pl = latencies[provider];
    if (!pl?.live) continue;
    const latencyMs = pl.latencyMs ?? 500;
    const costFactor = provider === "nvidia" ? 1.0 : 0.95;
    const score = sweBench * taskWeight * (1000 / latencyMs) * costFactor;
    if (!best || score > best.score) best = { score, provider, latencyMs };
  }
  return best;
}

router.post("/intent/classify", async (req, res) => {
  try {
    const body = req.body as ClassifyRequest;
    const intentText = body.intentText?.trim() ?? "";
    const repoUrl = body.repoUrl?.trim();
    const hasGitHubToken = body.hasGitHubToken ?? false;
    const availableProviders = body.availableProviders;

    if (!intentText) {
      res.json({ path: "nim" as IntentPath, reasoning: "No intent provided — defaulting to quick session." });
      return;
    }

    const isRepoIntent = detectsRepoIntent(intentText, repoUrl)
      || (hasGitHubToken && REPO_KEYWORD_RE.test(intentText));

    const repoSuggestion = isRepoIntent ? {
      message: repoUrl
        ? `Will clone ${repoUrl} at session start.`
        : "Paste your repository URL below to auto-clone on launch.",
    } : undefined;

    // ── Repo intent: working on an existing codebase ──────────────────────
    if (isRepoIntent) {
      const taskType = inferTaskType(intentText);
      const isLargeTask = /\b(refactor|restructur|rewrite|migrat|large|full.?repo|entire|whole|comprehensive)\b/i.test(intentText);

      if (isLargeTask) {
        // Large repo task → gpu path (needs persistent workspace)
        res.json({
          path: "gpu" as IntentPath,
          gpuSuggestion: {
            tier: "Standard",
            description: "Large-scale repo work needs dedicated compute for full-codebase reasoning.",
            estimatedStartMin: 25,
          },
          repoSuggestion,
          reasoning: `This looks like a substantial task on ${repoUrl ? repoUrl.split("/").slice(-2).join("/") : "your repo"}. Dedicated GPU compute gives you full-repo reasoning and persistent workspace.`,
          tokenMode: "core",
          skillBundle: "auto",
        });
        return;
      }

      // Small repo task: score NIM models → prefer nim path, fallback to choice
      const [models, latencies, configured] = await Promise.all([
        listNimModels(),
        getProviderLatencies(),
        Promise.resolve(getConfiguredProviders()),
      ]);
      const taskWeight = TASK_TYPE_WEIGHTS[taskType] ?? 0.9;

      let bestModelId: string | null = null;
      let bestProvider: string | null = null;
      let bestLatencyMs: number | null = null;
      let bestScore = -Infinity;

      for (const model of models) {
        const result = scoreBestProvider(model, latencies, configured, taskWeight, availableProviders);
        if (result && result.score > bestScore) {
          bestScore = result.score;
          bestModelId = model.nimModelId;
          bestProvider = result.provider;
          bestLatencyMs = result.latencyMs;
        }
      }

      const nimModel = models.find(m => m.nimModelId === bestModelId);
      const providerLabel = bestProvider ? (PROVIDER_CONFIG[bestProvider]?.displayName ?? bestProvider) : "a configured provider";
      const repoName = repoUrl ? repoUrl.split("/").slice(-2).join("/") : "your repo";

      // Path: "nim" if we have a good NIM match; "choice" if marginal or no live providers
      const path: IntentPath = bestModelId ? "nim" : "choice";

      res.json({
        path,
        reasoning: bestModelId
          ? `Looks like you want to work on ${repoName}. ${nimModel?.displayName ?? bestModelId} is ready instantly — connect your repo and it will clone it in seconds.`
          : `Looks like you want to work on an existing repository. Connect your repo URL and GitHub token below, then choose a session type.`,
        nimSuggestion: bestModelId ? {
          nimModelId: bestModelId,
          nimProvider: bestProvider,
          displayName: nimModel?.displayName ?? bestModelId,
          providerLabel,
          estimatedStartMin: 2,
          description: "Repo cloned automatically at session start.",
          sweBenchScore: nimModel?.sweBenchScore ?? null,
          benchmarkVariant: nimModel?.benchmarkVariant ?? null,
        } : null,
        gpuSuggestion: path === "choice" ? {
          tier: "Standard",
          description: "Full GPU power with persistent workspace — better for large refactors.",
          estimatedStartMin: 25,
        } : undefined,
        repoSuggestion,
        tokenMode: "core",
        skillBundle: "auto",
      });
      return;
    }

    // ── Standard classification: no repo context ──────────────────────────
    const taskType = inferTaskType(intentText);
    const complexity = inferComplexity(intentText, repoUrl, taskType);

    if (complexity === "deep" || taskType === "team") {
      res.json({
        path: "gpu" as IntentPath,
        gpuSuggestion: {
          tier: taskType === "team" ? "Pro" : "Standard",
          description: taskType === "team"
            ? "Team sessions with parallel IDEs work best on dedicated GPU hardware."
            : "Large refactors and full-repo reasoning need dedicated compute.",
          estimatedStartMin: 25,
        },
        reasoning: taskType === "team"
          ? "Team sessions require dedicated GPU compute for parallel IDE access."
          : `Large-scale ${taskType} tasks benefit from dedicated GPU hardware for full-repo reasoning.`,
        tokenMode: "core",
        skillBundle: "auto",
      });
      return;
    }

    const [models, latencies, configured] = await Promise.all([
      listNimModels(),
      getProviderLatencies(),
      Promise.resolve(getConfiguredProviders()),
    ]);
    const taskWeight = TASK_TYPE_WEIGHTS[taskType];

    let bestModelId: string | null = null;
    let bestProvider: string | null = null;
    let bestLatency: number | null = null;
    let bestScore = -Infinity;

    for (const model of models) {
      const result = scoreBestProvider(model, latencies, configured, taskWeight, availableProviders);
      if (result && result.score > bestScore) {
        bestScore = result.score;
        bestModelId = model.nimModelId;
        bestProvider = result.provider;
        bestLatency = result.latencyMs;
      }
    }

    // Fallback: pick any configured provider if no live provider found
    if (!bestModelId) {
      for (const model of models) {
        const providers = eligibleProviders(model, configured, availableProviders);
        if (providers.length > 0) {
          bestModelId = model.nimModelId;
          bestProvider = providers[0];
          break;
        }
      }
    }

    const nimModel = models.find(m => m.nimModelId === bestModelId);
    const providerLabel = bestProvider ? (PROVIDER_CONFIG[bestProvider]?.displayName ?? bestProvider) : "configured provider";

    if (complexity === "quick" && bestModelId) {
      const reasoning = bestLatency
        ? `${nimModel?.displayName ?? bestModelId} scores highest for ${taskType} tasks and ${providerLabel} is responding at ${bestLatency}ms.`
        : `${nimModel?.displayName ?? bestModelId} is the best available model for ${taskType} tasks via ${providerLabel}.`;

      res.json({
        path: "nim" as IntentPath,
        nimSuggestion: {
          nimModelId: bestModelId,
          nimProvider: bestProvider,
          displayName: nimModel?.displayName ?? bestModelId,
          providerLabel,
          estimatedStartMin: 2,
          sweBenchScore: nimModel?.sweBenchScore ?? null,
          benchmarkVariant: nimModel?.benchmarkVariant ?? null,
        },
        reasoning,
        tokenMode: "core",
        skillBundle: "auto",
      });
    } else {
      res.json({
        path: "choice" as IntentPath,
        nimSuggestion: bestModelId ? {
          nimModelId: bestModelId,
          nimProvider: bestProvider,
          displayName: nimModel?.displayName ?? bestModelId,
          providerLabel,
          estimatedStartMin: 2,
          description: "Best for focused builds and rapid iteration.",
          sweBenchScore: nimModel?.sweBenchScore ?? null,
          benchmarkVariant: nimModel?.benchmarkVariant ?? null,
        } : null,
        gpuSuggestion: {
          tier: "Standard",
          description: "Full power for larger tasks and multi-file changes.",
          estimatedStartMin: 25,
        },
        reasoning: `Task complexity is moderate — a quick hosted session is usually enough, but dedicated GPU hardware gives you more headroom for this ${taskType} task.`,
        tokenMode: "core",
        skillBundle: "auto",
      });
    }
  } catch (err) {
    logger.error({ err }, "Intent classification failed");
    res.status(500).json({ error: "Classification failed" });
  }
});

export default router;
