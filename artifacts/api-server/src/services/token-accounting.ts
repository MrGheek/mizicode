/**
 * token-accounting.ts — RFC 0001 Phase 3 (Layer 5: universal spend ledger)
 *
 * Generalizes the Vultr-only per-token accounting in llm-client.ts to every
 * provider, adds per-session tripwires (hard caps), a savings ledger for honest
 * `bytes_avoided` / `$ saved` attribution, and reserve-based auto-degrade
 * levels. Cost math only fires for providers with a verified per-token rate;
 * free/NIM/local providers always cost $0.00.
 *
 * Mirrors the context-mode accounting idea (per-event `bytes_avoided` /
 * `bytes_returned` + `model-prices`) without copying any vendored source.
 */

import { PROVIDER_TOKEN_RATES } from "./nim-catalog";

export interface RateEntry {
  /** USD per 1M input tokens billed for uncached prompt bytes. */
  inputPer1M: number;
  /** USD per 1M output (completion) tokens. */
  outputPer1M: number;
  /** Provider-native prefix-cache read (assumed ≈ 10% of input). */
  cacheReadPer1M: number;
  /** Provider-native prefix-cache write // invalidation (assumed ≈ 80% of input). */
  cacheWritePer1M: number;
}

/**
 * Per-token cost model by provider. `PROVIDER_TOKEN_RATES` holds combined
 * USD/token; we split it 50/50 across input/output as a coarse default.
 * Providers without a verified rate (NVIDIA NIM free tier, local Ollama,
 * Together/DeepInfra unpriced here) remain $0.00 until priced by an operator.
 */
export const LLM_RATES: Record<string, RateEntry> = Object.fromEntries(
  Object.entries(PROVIDER_TOKEN_RATES).map(([provider, combined]) => {
    const half = combined / 2;
    return [provider, { inputPer1M: half, outputPer1M: half, cacheReadPer1M: half * 0.1, cacheWritePer1M: half * 0.8 }];
  }),
);

export function rateFor(provider: string): RateEntry | undefined {
  return LLM_RATES[provider];
}

/** USD cost of a single inference call. Provider-cached prompt tokens are $0. */
export function estimateTokenCostUsd(
  provider: string,
  parts: { promptTokens: number; completionTokens: number; cachedTokens?: number },
): number {
  const r = rateFor(provider);
  if (!r) return 0;
  const billedInput = Math.max(0, parts.promptTokens - (parts.cachedTokens ?? 0));
  return (billedInput / 1e6) * r.inputPer1M + (parts.completionTokens / 1e6) * r.outputPer1M;
}

/**
 * Headroom-style cache-aware mutation math (arithmetic only): given a turn
 * whose `prefixTokens` are already cached by a provider, how much does keeping
 * them cached save vs re-billing them, and is rewriting/compressing a *frozen
 * prefix* worth the cache-invalidation cost?
 */
export function prefixCacheEconomics(provider: string, prefixTokens: number, cachedPrefixTokens: number): {
  noCacheUsd: number;
  withCacheUsd: number;
  savingsUsd: number;
} {
  const r = rateFor(provider);
  if (!r || cachedPrefixTokens <= 0) {
    return { noCacheUsd: 0, withCacheUsd: 0, savingsUsd: 0 };
  }
  const noCacheUsd = (prefixTokens / 1e6) * r.inputPer1M;
  const withCacheUsd = (Math.max(0, prefixTokens - cachedPrefixTokens) / 1e6) * r.inputPer1M;
  return { noCacheUsd, withCacheUsd, savingsUsd: noCacheUsd - withCacheUsd };
}

/**
 * True when compressing `saveableTokens` out of an already-cached prefix is
 * cheaper than the cache-invalidation cost of the rewrite. Correcting a frozen
 * prefix busts the provider KV cache from the mutation point onward, so the
 * invalidation cost is charged against the *whole* cached prefix — small wins
 * over a large cached prefix are never worth it.
 */
export function compressCachedPrefixWorthIt(provider: string, cachedPrefixTokens: number, saveableTokens: number): boolean {
  const r = rateFor(provider);
  if (!r) return false;
  const invalidateUsd = (Math.max(1, cachedPrefixTokens) / 1e6) * r.cacheWritePer1M;
  const savingUsd = (saveableTokens / 1e6) * r.inputPer1M;
  return savingUsd > invalidateUsd;
}

// ── Ledger ────────────────────────────────────────────────────────────────────

export interface LedgerSpend {
  id: number;
  ts: Date;
  sessionId: number | null;
  provider: string;
  model: string;
  taskClass: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface SpendRequest {
  sessionId?: number | null;
  provider: string;
  model: string;
  taskClass?: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface SpendSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface TripwireConfig {
  maxTokens?: number;
  maxUsd?: number;
  maxCalls?: number;
}

export interface LedgerStore {
  addSpend(s: Omit<LedgerSpend, "id" | "ts">): Promise<LedgerSpend>;
  spends(sessionId?: number): Promise<LedgerSpend[]>;
  setTripwire(sessionId: number, cfg: TripwireConfig): Promise<void>;
  tripwire(sessionId: number): Promise<TripwireConfig | undefined>;
}

export class MemoryLedgerStore implements LedgerStore {
  private nextId = 1;
  private spendsArr: LedgerSpend[] = [];
  private tripwires = new Map<number, TripwireConfig>();

  async addSpend(s: Omit<LedgerSpend, "id" | "ts">): Promise<LedgerSpend> {
    const entry: LedgerSpend = { ...s, id: this.nextId++, ts: new Date() };
    this.spendsArr.push(entry);
    return entry;
  }

  async spends(sessionId?: number): Promise<LedgerSpend[]> {
    return sessionId === undefined
      ? [...this.spendsArr]
      : this.spendsArr.filter((s) => s.sessionId === sessionId);
  }

  async setTripwire(sessionId: number, cfg: TripwireConfig): Promise<void> {
    this.tripwires.set(sessionId, cfg);
  }

  async tripwire(sessionId: number): Promise<TripwireConfig | undefined> {
    return this.tripwires.get(sessionId);
  }

  clear(): void {
    this.spendsArr = [];
    this.tripwires.clear();
  }
}

const defaultLedger = new MemoryLedgerStore();

export function getLedgerStore(): LedgerStore {
  return defaultLedger;
}

/** Test seam: wipes in-memory spends and tripwires. */
export function _resetLedgerForTest(): void {
  defaultLedger.clear();
}

/** Record one inference call in the universal ledger and return it. */
export async function recordSpend(req: SpendRequest): Promise<LedgerSpend> {
  const costUsd = estimateTokenCostUsd(req.provider, {
    promptTokens: req.promptTokens,
    completionTokens: req.completionTokens,
    cachedTokens: req.cachedTokens,
  });
  return defaultLedger.addSpend({
    sessionId: req.sessionId ?? null,
    provider: req.provider,
    model: req.model,
    taskClass: req.taskClass ?? null,
    promptTokens: req.promptTokens,
    completionTokens: req.completionTokens,
    cachedTokens: req.cachedTokens ?? 0,
    costUsd,
  });
}

export async function sessionSpendSummary(sessionId?: number): Promise<SpendSummary> {
  const rows = await defaultLedger.spends(sessionId);
  return rows.reduce<SpendSummary>(
    (acc, s) => {
      acc.calls += 1;
      acc.promptTokens += s.promptTokens;
      acc.completionTokens += s.completionTokens;
      acc.cachedTokens += s.cachedTokens;
      acc.costUsd += s.costUsd;
      return acc;
    },
    { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 },
  );
}

export async function setSessionTripwire(sessionId: number, cfg: TripwireConfig): Promise<void> {
  await defaultLedger.setTripwire(sessionId, cfg);
}

export interface TripwireState {
  tripped: boolean;
  reason: string | null;
}

export async function isTripwireTripped(sessionId: number): Promise<TripwireState> {
  const cfg = await defaultLedger.tripwire(sessionId);
  if (!cfg) return { tripped: false, reason: null };
  const spent = await sessionSpendSummary(sessionId);
  if (cfg.maxCalls !== undefined && spent.calls >= cfg.maxCalls) {
    return { tripped: true, reason: `call cap ${cfg.maxCalls} reached (${spent.calls})` };
  }
  if (cfg.maxTokens !== undefined && spent.promptTokens + spent.completionTokens >= cfg.maxTokens) {
    return { tripped: true, reason: `token cap ${cfg.maxTokens} reached` };
  }
  if (cfg.maxUsd !== undefined && spent.costUsd >= cfg.maxUsd) {
    return { tripped: true, reason: `spend cap $${cfg.maxUsd.toFixed(6)} reached` };
  }
  return { tripped: false, reason: null };
}

// ── Savings ledger (`bytes_avoided` / `$ saved`) ─────────────────────────────

export type SavingKind =
  | "cache_hit"
  | "bytes_avoided"
  | "local_offload"
  | "heuristic_reject"
  | "externalized_pointer"
  | "graph_known_answer"
  | "embedding_dedupe";

export interface SavingEntry {
  id: number;
  ts: Date;
  sessionId: number | null;
  kind: SavingKind;
  /** "tokens" or "bytes" avoided. */
  unit: "tokens" | "bytes";
  amount: number;
  estUsd: number;
  meta?: Record<string, unknown>;
}

export interface SaveRequest {
  sessionId?: number | null;
  kind: SavingKind;
  unit: "tokens" | "bytes";
  amount: number;
  /** Explicit USD attribution; when omitted, derived from the default price. */
  estUsd?: number;
  provider?: string;
  meta?: Record<string, unknown>;
}

/** $/token used for savings attribution when the caller or provider is unpriced. */
export const SAVINGS_DEFAULT_USD_PER_TOKEN = 0.0000014;

export class MemorySavingStore {
  private nextId = 1;
  private entries: SavingEntry[] = [];

  add(e: Omit<SavingEntry, "id" | "ts">): SavingEntry {
    const entry: SavingEntry = { ...e, id: this.nextId++, ts: new Date() };
    this.entries.push(entry);
    return entry;
  }

  all(): SavingEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

const defaultSavingStore = new MemorySavingStore();

export function getSavingStore(): MemorySavingStore {
  return defaultSavingStore;
}

export function _resetSavingsForTest(): void {
  defaultSavingStore.clear();
}

export async function recordSaving(req: SaveRequest): Promise<SavingEntry> {
  let estUsd = req.estUsd;
  if (estUsd === undefined) {
    const tokens = req.unit === "tokens" ? req.amount : req.amount / 4; // ≈ chars→tokens
    estUsd = tokens * SAVINGS_DEFAULT_USD_PER_TOKEN;
  }
  return defaultSavingStore.add({
    sessionId: req.sessionId ?? null,
    kind: req.kind,
    unit: req.unit,
    amount: req.amount,
    estUsd,
    meta: req.meta,
  });
}

export interface SavingsSummary {
  cacheHits: number;
  tokensSaved: number;
  bytesAvoided: number;
  estUsdSaved: number;
}

export function savingsSummary(): SavingsSummary {
  const entries = defaultSavingStore.all();
  return entries.reduce<SavingsSummary>(
    (acc, e) => {
      if (e.kind === "cache_hit") acc.cacheHits += 1;
      if (e.unit === "tokens") acc.tokensSaved += e.amount;
      else acc.bytesAvoided += e.amount;
      acc.estUsdSaved += e.estUsd;
      return acc;
    },
    { cacheHits: 0, tokensSaved: 0, bytesAvoided: 0, estUsdSaved: 0 },
  );
}

// ── Reserve-based auto-degrade ───────────────────────────────────────────────

export type ReserveLevel = "full" | "reduce" | "minimal";

/**
 * Degrade tier from remaining tripwire headroom: ≥60% left → full, ≥30% →
 * reduce, below → minimal. Without a tripwire, always full.
 */
export async function reserveLevelFor(sessionId: number): Promise<ReserveLevel> {
  const cfg = await defaultLedger.tripwire(sessionId);
  if (!cfg) return "full";
  const spent = await sessionSpendSummary(sessionId);

  const fraction = (used: number | undefined, cap: number | undefined): number => {
    if (used === undefined || cap === undefined || cap === 0) return -1;
    return used / cap;
  };

  const fracs = [
    fraction(spent.calls, cfg.maxCalls),
    fraction(spent.promptTokens + spent.completionTokens, cfg.maxTokens),
    fraction(spent.costUsd, cfg.maxUsd),
  ].filter((f) => f >= 0);

  const maxFrac = fracs.length === 0 ? 0 : Math.max(...fracs);
  if (maxFrac >= 0.7) return "minimal";
  if (maxFrac >= 0.4) return "reduce";
  return "full";
}