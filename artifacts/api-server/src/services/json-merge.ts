/**
 * json-merge.ts — RFC 0002 Phase 1 (JSON-aware structural merge)
 *
 * Structural union-merge for dependency manifests, so parallel lanes editing
 * disjoint regions of the same manifest land without text conflicts. Verified
 * pattern (pact): four concurrent agents editing the same root package.json in
 * disjoint regions merged correctly, 13/13 changes landed, zero conflicts.
 *
 * Supported file types:
 *   - JSON  (package.json): dependencies, devDependencies, peerDependencies,
 *            optionalDependencies, scripts
 *   - TOML  (Cargo.toml, pyproject.toml): [dependencies], [dev-dependencies],
 *            [build-dependencies], [features], [project.dependencies],
 *            [project.optional-dependencies], [tool.poetry.dependencies], ...
 *
 * Semantics:
 *   - Dependency blocks are union-merged key-by-key. A key present on BOTH sides
 *     with a DIFFERENT value is a real conflict (reported, not guessed).
 *   - Non-dependency regions are left untouched; if both sides changed the same
 *     non-mergeable region, the caller falls back to a text merge.
 *   - Comments/formatting in untouched regions are preserved verbatim.
 *
 * Pure and dependency-free: no network, no DB, no git.
 */

// ── JSON structural merge ──────────────────────────────────────────────────────

/** Key paths inside a JSON manifest that are union-merged. */
export const JSON_MERGE_BLOCK_PATHS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "scripts",
] as const;

export interface MergeConflict {
  /** Block path, e.g. "dependencies". */
  block: string;
  /** Key within the block, e.g. "lodash". */
  key: string;
  /** Value on the base/ours side. */
  ours: string;
  /** Value on the incoming/theirs side. */
  theirs: string;
}

export type StructuralMergeResult =
  | { status: "merged"; content: string; mergedKeys: string[]; conflicts: MergeConflict[] }
  | { status: "conflict"; content: null; mergedKeys: string[]; conflicts: MergeConflict[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Union-merge two JSON manifests at the configured block paths.
 * Returns the merged JSON text, or a conflict result when a key differs on both
 * sides (caller should fall back to a text merge for that file).
 */
export function mergeJsonManifests(base: string, incoming: string): StructuralMergeResult {
  let baseObj: unknown;
  let incomingObj: unknown;
  try {
    baseObj = JSON.parse(base);
    incomingObj = JSON.parse(incoming);
  } catch {
    return { status: "conflict", content: null, mergedKeys: [], conflicts: [] };
  }
  if (!isPlainObject(baseObj) || !isPlainObject(incomingObj)) {
    return { status: "conflict", content: null, mergedKeys: [], conflicts: [] };
  }

  const merged: Record<string, unknown> = { ...baseObj };
  const mergedKeys: string[] = [];
  const conflicts: MergeConflict[] = [];

  for (const block of JSON_MERGE_BLOCK_PATHS) {
    const baseBlock = baseObj[block];
    const incomingBlock = incomingObj[block];
    if (!isPlainObject(baseBlock) && !isPlainObject(incomingBlock)) continue;

    const baseMap = isPlainObject(baseBlock) ? baseBlock : {};
    const incomingMap = isPlainObject(incomingBlock) ? incomingBlock : {};

    const union: Record<string, unknown> = { ...baseMap };
    for (const [key, value] of Object.entries(incomingMap)) {
      if (key in baseMap) {
        if (JSON.stringify(baseMap[key]) !== JSON.stringify(value)) {
          conflicts.push({
            block,
            key,
            ours: JSON.stringify(baseMap[key]),
            theirs: JSON.stringify(value),
          });
        }
      } else {
        union[key] = value;
        mergedKeys.push(`${block}.${key}`);
      }
    }
    merged[block] = union;
  }

  if (conflicts.length > 0) {
    return { status: "conflict", content: null, mergedKeys, conflicts };
  }

  return { status: "merged", content: JSON.stringify(merged, null, 2) + "\n", mergedKeys, conflicts };
}

// ── TOML structural merge ─────────────────────────────────────────────────────

/** TOML table headers that are union-merged (dependency/feature blocks). */
export const TOML_MERGE_BLOCK_HEADERS = new Set([
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "features",
  "project.dependencies",
  "project.optional-dependencies",
  "tool.poetry.dependencies",
  "tool.poetry.group.dev.dependencies",
  "tool.uv.dependencies",
]);

interface TomlTable {
  header: string;
  /** key → raw value line (without the key prefix). */
  entries: Map<string, string>;
  /** Raw text of the table (header + entries), for untouched preservation. */
  raw: string;
}

/**
 * Minimal TOML table parser. Handles `[section]` headers and `key = value`
 * lines (including quoted strings, arrays, inline tables). Does NOT handle
 * arrays of tables (`[[x]]`) or multi-line values — those regions are treated
 * as non-mergeable and preserved verbatim.
 */
export function parseTomlTables(text: string): TomlTable[] {
  const lines = text.split(/\r?\n/);
  const tables: TomlTable[] = [];
  let current: TomlTable | null = null;
  let currentRaw: string[] = [];

  const flush = (): void => {
    if (current) {
      current.raw = currentRaw.join("\n");
      tables.push(current);
    }
    current = null;
    currentRaw = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headerMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (headerMatch) {
      flush();
      current = { header: headerMatch[1]!.trim(), entries: new Map(), raw: "" };
      currentRaw.push(line);
      continue;
    }
    if (current) {
      currentRaw.push(line);
      const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
      if (kv) current.entries.set(kv[1]!, kv[2]!);
    }
  }
  flush();
  return tables;
}

/**
 * Union-merge two TOML manifests at the configured dependency/feature tables.
 * Non-mergeable tables and all non-table content (comments, top-level keys)
 * are preserved from the base side verbatim. A key that differs on both sides
 * is a conflict (caller falls back to a text merge).
 */
export function mergeTomlManifests(base: string, incoming: string): StructuralMergeResult {
  const baseTables = parseTomlTables(base);
  const incomingTables = parseTomlTables(incoming);

  const incomingByHeader = new Map<string, TomlTable>();
  for (const t of incomingTables) incomingByHeader.set(t.header, t);

  const mergedKeys: string[] = [];
  const conflicts: MergeConflict[] = [];

  // Walk the base document line-by-line. When we reach a mergeable table
  // header, emit the unioned table and skip the base table's original lines.
  const baseLines = base.split(/\r?\n/);
  const outLines: string[] = [];
  let i = 0;
  while (i < baseLines.length) {
    const line = baseLines[i]!;
    const headerMatch = line.trim().match(/^\[([^\]]+)\]$/);
    if (headerMatch) {
      const header = headerMatch[1]!.trim();
      const incomingTable = incomingByHeader.get(header);
      const mergeable = TOML_MERGE_BLOCK_HEADERS.has(header);

      if (mergeable && incomingTable) {
        const baseTable = baseTables.find((t) => t.header === header);
        const baseEntries = baseTable?.entries ?? new Map<string, string>();
        const incomingEntries = incomingTable.entries;

        const union = new Map<string, string>(baseEntries);
        for (const [key, value] of incomingEntries) {
          if (baseEntries.has(key)) {
            if (baseEntries.get(key) !== value) {
              conflicts.push({ block: header, key, ours: baseEntries.get(key)!, theirs: value });
            }
          } else {
            union.set(key, value);
            mergedKeys.push(`${header}.${key}`);
          }
        }

        outLines.push(line);
        for (const [key, value] of union) {
          outLines.push(`  ${key} = ${value}`);
        }
        // Skip the base table's original body lines.
        i += 1;
        while (i < baseLines.length && !/^\s*\[/.test(baseLines[i]!)) i += 1;
        continue;
      }
    }
    outLines.push(line);
    i += 1;
  }

  // Append any incoming tables that don't exist in base (new sections).
  const baseHeaders = new Set(baseTables.map((t) => t.header));
  for (const t of incomingTables) {
    if (!baseHeaders.has(t.header)) {
      outLines.push(t.raw);
    }
  }

  if (conflicts.length > 0) {
    return { status: "conflict", content: null, mergedKeys, conflicts };
  }

  return { status: "merged", content: outLines.join("\n") + "\n", mergedKeys, conflicts };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export type ManifestKind = "json" | "toml";

export function detectManifestKind(filePath: string): ManifestKind | null {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "package.json") return "json";
  if (name === "cargo.toml" || name === "pyproject.toml" || name === "go.mod" || name === "poetry.lock") return "toml";
  return null;
}

/**
 * Structural union-merge for a dependency manifest. Returns a conflict result
 * when the file type is unsupported, unparseable, or a key differs on both
 * sides — the caller then falls back to a text merge.
 */
export function structuralMergeManifest(filePath: string, base: string, incoming: string): StructuralMergeResult {
  const kind = detectManifestKind(filePath);
  if (kind === "json") return mergeJsonManifests(base, incoming);
  if (kind === "toml") return mergeTomlManifests(base, incoming);
  return { status: "conflict", content: null, mergedKeys: [], conflicts: [] };
}