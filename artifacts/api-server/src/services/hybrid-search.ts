/**
 * hybrid-search.ts — RFC 0001 Phase 2c (RTK / context-mode patterns, no ELv2 code)
 *
 * Two mechanisms for taming large tool/terminal output before it reaches the LLM:
 *
 *  1. Externalize-big-output. Any tool/grep/read result larger than a threshold
 *     is stored verbatim and a short searchable pointer is returned instead of
 *     the raw bytes. The original is recoverable via ctx_search(key, source).
 *
 *  2. Semantic terminal filtering + tee-recovery. Shell/test/lint output is
 *     condensed by collapsing passing-test runs to counts, eliding repeated
 *     separator/ornament runs, and deduping consecutive duplicate lines — while
 *     preserving exit codes, `path:line` refs, signatures, imports, and failure
 *     details. The full unfiltered output is persisted so a failed run can be
 *     re-read without re-executing.
 *
 * Storage is pluggable. The default MemoryExternalizeStore keeps blobs for the
 * process lifetime; the underlying store engine is an RFC open question (#6),
 * so a durable adapter can be swapped in without touching the callers.
 */

import { createHash } from "node:crypto";

export const EXTERNALIZE_THRESHOLD_BYTES = 100 * 1024;
export const EXTERNALIZE_THRESHOLD_INTENT_BYTES = 25 * 1024;

// ── Store ─────────────────────────────────────────────────────────────────────

export type ExternalizeContentType = "tool-output" | "terminal";

export interface ExternalizedInfo {
  key: string;
  source: string;
  contentType: ExternalizeContentType;
  sizeBytes: number;
  createdAt: Date;
}

export interface ExternalizeStore {
  /** Store the blob verbatim; returns a stable, content-derived key. */
  put(blob: { source: string; contentType: ExternalizeContentType; content: string; createdAt?: Date }): Promise<string>;
  /** Verbatim recovery by key; null when absent. */
  get(key: string): Promise<string | null>;
  /** Meta lookup for pointer rendering and listing. */
  info(key: string): Promise<ExternalizedInfo | null>;
  /** Line-scoped substring search across stored blobs. */
  search(query: string, opts: { source?: string; limit?: number }): Promise<Array<{ key: string; source: string; snippet: string; score: number }>>;
}

/** Content-derived key: stable across duplicate externalizations (free dedupe). */
export function externalizeKey(source: string, content: string): string {
  const fingerprint = createHash("sha256").update(content).digest("hex");
  const slug = source.replace(/[^a-z0-9._-]/gi, "_").slice(0, 40).toLowerCase();
  return `${slug}::${fingerprint.slice(0, 12)}`;
}

export class MemoryExternalizeStore implements ExternalizeStore {
  private blobs = new Map<string, { source: string; contentType: ExternalizeContentType; content: string; createdAt: Date }>();

  async put(blob: { source: string; contentType: ExternalizeContentType; content: string; createdAt?: Date }): Promise<string> {
    const key = externalizeKey(blob.source, blob.content);
    if (!this.blobs.has(key)) {
      this.blobs.set(key, { ...blob, createdAt: blob.createdAt ?? new Date() });
    }
    return key;
  }

  async get(key: string): Promise<string | null> {
    return this.blobs.get(key)?.content ?? null;
  }

  async info(key: string): Promise<ExternalizedInfo | null> {
    const b = this.blobs.get(key);
    if (!b) return null;
    return { key, source: b.source, contentType: b.contentType, sizeBytes: byteLength(b.content), createdAt: b.createdAt };
  }

  async search(query: string, opts: { source?: string; limit?: number }): Promise<Array<{ key: string; source: string; snippet: string; score: number }>> {
    const needle = query.toLowerCase();
    const limit = opts.limit ?? 8;
    const results: Array<{ key: string; source: string; snippet: string; score: number }> = [];
    for (const [key, blob] of this.blobs) {
      if (opts.source && blob.source !== opts.source) continue;
      if (needle.length === 0) continue;
      const lines = blob.content.split(/\r?\n/);
      let matches = 0;
      let first = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches++;
          if (first === -1) first = i;
        }
      }
      if (matches === 0) continue;
      const from = Math.max(0, first - 1);
      const snippet = lines.slice(from, Math.min(lines.length, first + 3)).join("\n");
      results.push({ key, source: blob.source, snippet, score: matches + 1 / (first + 1) });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  get size(): number {
    return this.blobs.size;
  }
}

const defaultStore = new MemoryExternalizeStore();

export function getDefaultExternalizeStore(): ExternalizeStore {
  return defaultStore;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── 1. Externalize-big-output ─────────────────────────────────────────────────

export interface ExternalizeRequest {
  content: string;
  source: string;
  /** Override the size threshold; when `intentScoped` is set the 25 KB intent threshold applies. */
  thresholdBytes?: number;
  intentScoped?: boolean;
  contentType?: ExternalizeContentType;
  store?: ExternalizeStore;
}

export type ExternalizeDecision =
  | { kind: "kept"; sizeBytes: number }
  | { kind: "externalized"; key: string; pointer: string; sizeBytes: number; bytesAvoided: number };

export function buildPointerText(p: { source: string; key: string; sizeBytes: number }): string {
  return [
    `[MIZI externalized:${p.key}]`,
    `source: ${p.source}`,
    `${formatBytes(p.sizeBytes)} stored verbatim — do not re-execute. Re-read via ctx_search(source="${p.source}", key="${p.key}").`,
  ].join("\n");
}

/**
 * Store oversized output and return a pointer; otherwise keep the content as-is.
 */
export async function externalizeIfLarge(req: ExternalizeRequest): Promise<ExternalizeDecision> {
  const size = byteLength(req.content);
  const threshold = req.thresholdBytes ?? (req.intentScoped ? EXTERNALIZE_THRESHOLD_INTENT_BYTES : EXTERNALIZE_THRESHOLD_BYTES);
  if (size <= threshold) return { kind: "kept", sizeBytes: size };

  const store = req.store ?? defaultStore;
  const contentType = req.contentType ?? "tool-output";
  const key = await store.put({ source: req.source, contentType, content: req.content });
  const pointer = buildPointerText({ source: req.source, key, sizeBytes: size });
  return { kind: "externalized", key, pointer, sizeBytes: size, bytesAvoided: size - byteLength(pointer) };
}

// ── 2. Semantic terminal filtering + tee-recovery ─────────────────────────────

export interface TerminalFilterStats {
  linesIn: number;
  linesOut: number;
  bytesIn: number;
  bytesOut: number;
  bytesAvoided: number;
  passingTestsCollapsed: number;
  repeatedLinesDeduped: number;
  ornamentRunsCollapsed: number;
}

/** Classification "keep-groups" surfaced for verification (preservation contract). */
export interface TerminalPreserved {
  exitCodes: string[];
  pathLineRefs: string[];
  signatures: string[];
  imports: string[];
}

export interface TerminalFilterResult {
  condensed: string;
  stats: TerminalFilterStats;
  preserved: TerminalPreserved;
  /** Present when the original output was persisted for tee-recovery. */
  originalKey: string | null;
  pointer: string | null;
}

export interface TerminalFilterOptions {
  source?: string;
  store?: ExternalizeStore;
  /** Persist the full unfiltered output for tee-recovery. Default true when a store is available. */
  persistOriginal?: boolean;
}

const ORNAMENT_RE = /^[\-.=_*#~\u00b7\u2026:]{3,}$/;
const PASS_RE = /\bPASS(?:ED|ING)?\b|\bpass(?:ed|ing)?\b|\u2713|\u2714/;
const EXIT_CODE_RE = /\bexit(?:ed)? code(?:\s*[:=]\s*|\s+)\d+\b/i;
const PATH_LINE_RE = /\b[a-z0-9_@./\\-]+\.(?:ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|c|cpp|cc|h|hpp|cs|css|scss|less|html?|json|ya?ml|ini|toml|sh|bash|zsh|ps1|sql|md|txt|log|env|config)\s*:\s*\d+(?::\s*\d+)?\b/i;
const IMPORT_RE = /^\s*(?:import\s+(?:\w+|\{|\*)|from\s+[.\w/"']|require\s*\(|using\s+\w+)/;
const SIGNATURE_RE = /^\s*(?:export\s+|default\s+|async\s+)*(?:function\b|def\b|class\b|interface\b|struct\b|trait\b|enum\b|fn\b|impl\b)|\([^)\n]*\)\s*(?::|->|=>|\{)/;

/**
 * A line eligible for "collapse passing tests to counts": a bare pass verdict
 * with no digits (latency/timing) and no failure wording. Counts-summary lines
 * like "3 passed, 1 failed in 0.8s" carry digits and failure wording, so they
 * pass through verbatim — the collapsing only ever eats individual verdict lines.
 */
function isCollapsiblePassLine(t: string): boolean {
  return PASS_RE.test(t) && !/\d/.test(t) && !/\b(?:failed?|error)\b/i.test(t);
}

function emptyStats(): TerminalFilterStats {
  return {
    linesIn: 0,
    linesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    bytesAvoided: 0,
    passingTestsCollapsed: 0,
    repeatedLinesDeduped: 0,
    ornamentRunsCollapsed: 0,
  };
}

/**
 * Condense terminal/test/lint output while honoring the preservation contract:
 * exit codes, `path:line` refs, signatures, imports and failure details always
 * survive; passing-test runs, separator runs, and consecutive duplicates collapse.
 */
export async function semanticFilterTerminal(raw: string, opts?: TerminalFilterOptions): Promise<TerminalFilterResult> {
  const lines = raw.split(/\r?\n/);
  const stats = emptyStats();
  stats.linesIn = lines.length;
  stats.bytesIn = byteLength(raw);

  const preserved: TerminalPreserved = { exitCodes: [], pathLineRefs: [], signatures: [], imports: [] };
  const out: string[] = [];

  let passRun = 0;
  let ornamentRun = 0;
  let prevPlain: { line: string; count: number } | null = null;

  const x = (line: string): void => {
    out.push(line);
  };

  const flushPassRun = (): void => {
    if (passRun === 0) return;
    x(`\u2026 ${passRun} passing test line(s) (collapsed)`);
    stats.passingTestsCollapsed += passRun;
    passRun = 0;
  };

  const flushOrnamentRun = (): void => {
    if (ornamentRun === 0) return;
    if (ornamentRun > 1) {
      x(`\u2026 \u2500\u2500 ${ornamentRun} separator line(s) elided`);
      stats.ornamentRunsCollapsed += ornamentRun - 1;
    }
    ornamentRun = 0;
  };

  const flushPlain = (): void => {
    if (!prevPlain) return;
    if (prevPlain.count > 1) {
      x(`${prevPlain.line}  \u27f9 ${prevPlain.count}\u00d7`);
      stats.repeatedLinesDeduped += prevPlain.count - 1;
    } else {
      x(prevPlain.line);
    }
    prevPlain = null;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trimEnd();
    const t = trimmed.trim();
    if (t.length === 0) continue;

    // Ornament/separator runs elide to a single marker.
    if (ORNAMENT_RE.test(t)) {
      flushPassRun();
      flushPlain();
      ornamentRun++;
      continue;
    }

    // Consecutive passing-test lines collapse to a count.
    if (isCollapsiblePassLine(t)) {
      flushOrnamentRun();
      flushPlain();
      passRun++;
      continue;
    }

    // Everything else passes through verbatim (failures, errors, and
    // unrecognized noise are preserved by construction) — but register the
    // interesting fragments for the preservation contract.
    flushPassRun();
    flushOrnamentRun();

    const exitMatch = t.match(EXIT_CODE_RE);
    if (exitMatch) preserved.exitCodes.push(exitMatch[0]);

    const pathMatches = t.match(PATH_LINE_RE);
    const isImport = IMPORT_RE.test(t);
    const isSignature = SIGNATURE_RE.test(t);

    if (isImport) preserved.imports.push(t);
    if (pathMatches) preserved.pathLineRefs.push(...pathMatches);
    if (isSignature) preserved.signatures.push(t);

    if (prevPlain && prevPlain.line === trimmed) {
      prevPlain.count++;
      continue;
    }
    flushPlain();
    prevPlain = { line: trimmed, count: 1 };
  }
  flushPassRun();
  flushOrnamentRun();
  flushPlain();

  const condensed = out.join("\n");
  stats.linesOut = out.length;
  stats.bytesOut = byteLength(condensed);
  stats.bytesAvoided = stats.bytesIn - stats.bytesOut;

  // Tee-recovery: persist the full unfiltered output so a failed run can be
  // re-read without re-executing.
  const store = opts?.store ?? defaultStore;
  if (opts?.persistOriginal !== false && opts?.source) {
    const originalKey = await store.put({ source: `${opts.source}.original`, contentType: "terminal", content: raw });
    const pointer = buildPointerText({ source: `${opts.source}.original`, key: originalKey, sizeBytes: stats.bytesIn });
    return { condensed, stats, preserved, originalKey, pointer };
  }

  return { condensed, stats, preserved, originalKey: null, pointer: null };
}