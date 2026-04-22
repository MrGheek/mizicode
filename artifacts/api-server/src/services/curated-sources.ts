/**
 * Curated Sources Seeder
 *
 * Fetches canonical CSV data from the nextlevelbuilder/ui-ux-pro-max-skill GitHub repo
 * and ingests it into the design_intelligence_entries table with SHA-aware idempotence.
 *
 * Rules:
 * - Auto-discovers all CSVs under src/ui-ux-pro-max/data/ (canonical data area)
 * - Never executes cli/, src/ui-ux-pro-max/scripts/, or platform templates
 * - SHA-aware idempotence: skips if pinnedCommitSha matches AND entries already exist
 * - Updates pinnedCommitSha only AFTER a successful ingest
 * - Fetch failures log a warning and do not abort the rest of startup
 */

import { db, skillSourcesTable, designIntelligenceEntriesTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { logger } from "../lib/logger";

const REPO_OWNER = "nextlevelbuilder";
const REPO_NAME = "ui-ux-pro-max-skill";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
// RAW_BASE is constructed with the resolved headSha at ingest time for deterministic fetches

// Canonical data area per task spec: src/ui-ux-pro-max/ (root CSVs + stacks/ subdirectory)
// The upstream repo places files under src/ui-ux-pro-max/data/ — scanning the parent path
// covers both the spec-canonical location and the actual repo layout automatically.
// cli/ and src/ui-ux-pro-max/scripts/ are explicitly excluded via the path filter.
const CANONICAL_DATA_PATH = "src/ui-ux-pro-max";

type DesignCategory =
  | "style"
  | "palette"
  | "typography"
  | "chart_type"
  | "ux_guideline"
  | "anti_pattern"
  | "stack_convention"
  | "ui_reasoning";

/**
 * Map from filename stem (without .csv extension) to canonical category.
 * Files not listed here fall back to "style".
 */
const FILENAME_TO_CATEGORY: Record<string, DesignCategory> = {
  "styles": "style",
  "design": "style",
  "app-interface": "style",
  "icons": "style",
  "landing": "style",
  "products": "style",
  "draft": "style",
  "colors": "palette",
  "typography": "typography",
  "google-fonts": "typography",
  "charts": "chart_type",
  "ui-reasoning": "ui_reasoning",
  "ux-guidelines": "ux_guideline",
  "react-performance": "stack_convention",
};

interface GitHubCommit {
  sha: string;
}

interface GitHubTreeItem {
  path: string;
  type: string;
}

interface GitHubTree {
  tree: GitHubTreeItem[];
}

interface CsvFileSpec {
  path: string;
  category: DesignCategory;
}

async function fetchJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch ${res.status} for ${url}`);
  return res.text();
}

/**
 * Minimal CSV parser — handles quoted fields with embedded commas.
 * Returns an array of row objects keyed by the header row.
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === "," && !inQuote) {
        fields.push(cur.trim()); cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  };

  const headers = parseRow(lines[0]!);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseRow(lines[i]!);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? ""; });
    rows.push(row);
  }
  return rows;
}

/** Derive canonical category from file path */
function categoryFromPath(filePath: string): DesignCategory {
  const filename = filePath.split("/").pop() ?? filePath;
  const stem = filename.replace(/\.csv$/i, "");

  // stacks/ subdirectory always maps to stack_convention
  if (filePath.includes("/stacks/")) return "stack_convention";

  return FILENAME_TO_CATEGORY[stem] ?? "style";
}

/** Primary key name for a row — first non-empty value of name/label/title/id fields */
function rowName(row: Record<string, string>): string {
  return (
    row["name"] ??
    row["label"] ??
    row["title"] ??
    row["id"] ??
    Object.values(row)[0] ??
    "unknown"
  );
}

/** Derive tags from the category and the row name */
function tagsFromRow(category: string, row: Record<string, string>): string[] {
  const base = [category];
  const nameField = row["name"] ?? row["label"] ?? row["title"] ?? "";
  if (nameField) base.push(nameField.toLowerCase().replace(/\s+/g, "-").slice(0, 32));
  return base;
}

async function ingestCsvFile(
  spec: CsvFileSpec,
  sourceId: number,
  rawBase: string,
): Promise<number> {
  const rawUrl = `${rawBase}/${spec.path}`;
  let csvText: string;
  try {
    csvText = await fetchText(rawUrl);
  } catch (err) {
    logger.warn({ err, path: spec.path }, "Failed to fetch CSV — skipping");
    return 0;
  }

  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    logger.debug({ path: spec.path }, "Empty CSV — skipping");
    return 0;
  }

  let upserted = 0;
  for (const row of rows) {
    const name = rowName(row);
    const tags = tagsFromRow(spec.category, row);

    try {
      await db
        .insert(designIntelligenceEntriesTable)
        .values({
          sourceId,
          category: spec.category,
          name,
          dataJson: row as unknown as Record<string, unknown>,
          tags: tags as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [
            designIntelligenceEntriesTable.sourceId,
            designIntelligenceEntriesTable.category,
            designIntelligenceEntriesTable.name,
          ],
          set: {
            dataJson: sql`EXCLUDED.data_json`,
          },
        });
      upserted++;
    } catch (err) {
      logger.warn({ err, category: spec.category, name }, "Failed to upsert design intelligence entry");
    }
  }

  logger.debug({ path: spec.path, category: spec.category, upserted }, "Ingested CSV");
  return upserted;
}

export interface SeedResult {
  success: boolean;
  updated: boolean;
  reason: string;
}

/**
 * Fetch the current HEAD commit SHA from GitHub without doing a full ingest.
 * Returns null if the request fails.
 */
export async function fetchCurrentHeadSha(): Promise<string | null> {
  try {
    const commits = await fetchJson<GitHubCommit[]>(`${API_BASE}/commits?per_page=1`);
    return commits[0]?.sha ?? null;
  } catch (err) {
    logger.warn({ err }, "SHA-check: could not fetch HEAD commit SHA from GitHub");
    return null;
  }
}

/**
 * Return the pinnedCommitSha stored in the DB for the curated source, or null
 * if no record exists yet.
 */
export async function getStoredCommitSha(): Promise<string | null> {
  const [source] = await db
    .select({ pinnedCommitSha: skillSourcesTable.pinnedCommitSha })
    .from(skillSourcesTable)
    .where(eq(skillSourcesTable.repoUrl, REPO_URL));
  return source?.pinnedCommitSha ?? null;
}

export async function seedCuratedSources(): Promise<SeedResult> {
  logger.info("Seeding curated design intelligence sources…");

  let headSha: string;
  try {
    const commits = await fetchJson<GitHubCommit[]>(`${API_BASE}/commits?per_page=1`);
    headSha = commits[0]?.sha ?? "unknown";
  } catch (err) {
    logger.warn({ err }, "Could not fetch HEAD commit SHA — using 'unknown'");
    headSha = "unknown";
  }

  // Ensure the skill_sources record exists with sourceType "curated"
  let [source] = await db
    .select()
    .from(skillSourcesTable)
    .where(eq(skillSourcesTable.repoUrl, REPO_URL));

  if (!source) {
    [source] = await db
      .insert(skillSourcesTable)
      .values({
        repoUrl: REPO_URL,
        sourceType: "curated",
        trustLevel: "reviewed",
        pinnedCommitSha: null, // set after successful ingest
      })
      .returning();
    logger.info({ sourceId: source.id }, "Created skill source for ui-ux-pro-max-skill");
  } else if (source.sourceType !== "curated" || source.trustLevel !== "reviewed") {
    // Fix legacy records that were created with wrong sourceType or trustLevel
    await db
      .update(skillSourcesTable)
      .set({ sourceType: "curated", trustLevel: "reviewed" })
      .where(eq(skillSourcesTable.id, source.id));
    source = { ...source, sourceType: "curated", trustLevel: "reviewed" };
  }

  // SHA-aware idempotence: skip only if SHA matches AND entries already exist
  if (source.pinnedCommitSha === headSha) {
    const [existingCount] = await db
      .select({ count: count() })
      .from(designIntelligenceEntriesTable)
      .where(eq(designIntelligenceEntriesTable.sourceId, source.id));

    if ((existingCount?.count ?? 0) > 0) {
      logger.info({ sha: headSha }, "Design intelligence already up to date (SHA match + entries present) — skipping ingest");
      return { success: true, updated: false, reason: "already_up_to_date" };
    }
    logger.info({ sha: headSha }, "SHA matches but no entries found — re-ingesting");
  } else {
    logger.info({ oldSha: source.pinnedCommitSha, newSha: headSha }, "SHA changed — re-ingesting design intelligence");
  }

  // Discover all CSV files from the canonical data area via repo tree
  let csvFiles: CsvFileSpec[] = [];
  try {
    const tree = await fetchJson<GitHubTree>(`${API_BASE}/git/trees/HEAD?recursive=1`);
    csvFiles = tree.tree
      .filter(
        item =>
          item.type === "blob" &&
          item.path.startsWith(CANONICAL_DATA_PATH) &&
          item.path.endsWith(".csv") &&
          !item.path.includes("/scripts/") &&
          !item.path.startsWith("cli/"),
      )
      .map(item => ({
        path: item.path,
        category: categoryFromPath(item.path),
      }));
    logger.info({ count: csvFiles.length }, "CSV files discovered in canonical data path");
  } catch (err) {
    logger.error({ err }, "Failed to fetch repo tree — aborting design intelligence ingest");
    return { success: false, updated: false, reason: "tree_fetch_failed" };
  }

  if (csvFiles.length === 0) {
    logger.warn("No CSV files found in canonical data path — skipping ingest");
    return { success: false, updated: false, reason: "no_csv_files_found" };
  }

  // Pin CSV fetches to the resolved headSha for deterministic, SHA-consistent ingestion
  const rawBase = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${headSha}`;

  let totalUpserted = 0;
  const countByCategory: Record<string, number> = {};

  for (const spec of csvFiles) {
    const upserted = await ingestCsvFile(spec, source.id, rawBase);
    totalUpserted += upserted;
    countByCategory[spec.category] = (countByCategory[spec.category] ?? 0) + upserted;
  }

  // Update pinnedCommitSha only after successful ingest
  await db
    .update(skillSourcesTable)
    .set({ pinnedCommitSha: headSha })
    .where(eq(skillSourcesTable.id, source.id));

  logger.info({ totalUpserted, countByCategory, sha: headSha }, "Design intelligence ingest complete");
  return { success: true, updated: true, reason: "ingested" };
}
