/**
 * Curated Sources Seeder
 *
 * Fetches canonical CSV data from the nextlevelbuilder/ui-ux-pro-max-skill GitHub repo
 * and ingests it into the design_intelligence_entries table with SHA-aware idempotence.
 *
 * Rules:
 * - Only reads from src/ui-ux-pro-max/data/ (canonical data area)
 * - Never touches cli/ or scripts/
 * - Uses ON CONFLICT DO UPDATE for idempotent re-runs
 * - Stores the pinned commit SHA on the skill_sources row for drift detection
 */

import { db, skillSourcesTable, designIntelligenceEntriesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const REPO_OWNER = "nextlevelbuilder";
const REPO_NAME = "ui-ux-pro-max-skill";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
const API_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

const CANONICAL_DATA_PATH = "src/ui-ux-pro-max/data";

interface GitHubTreeItem {
  path: string;
  type: string;
  sha: string;
  url: string;
}

interface GitHubTree {
  sha: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
}

interface GitHubCommit {
  sha: string;
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

/** Derive a human-friendly category name from the CSV filename */
function categoryFromPath(filePath: string): string {
  const filename = filePath.split("/").pop() ?? filePath;
  return filename.replace(/\.csv$/i, "").replace(/-/g, "_");
}

/** Derive tags from the category and first few field values */
function tagsFromRow(category: string, row: Record<string, string>): string[] {
  const base = [category];
  const nameField = row["name"] ?? row["label"] ?? row["title"] ?? "";
  if (nameField) base.push(nameField.toLowerCase().replace(/\s+/g, "-").slice(0, 32));
  return base;
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

export async function seedCuratedSources(): Promise<void> {
  logger.info("Seeding curated design intelligence sources…");

  let headSha: string;
  try {
    const commits = await fetchJson<GitHubCommit[]>(`${API_BASE}/commits?per_page=1`);
    headSha = commits[0]?.sha ?? "unknown";
  } catch (err) {
    logger.warn({ err }, "Could not fetch HEAD commit SHA — using 'unknown'");
    headSha = "unknown";
  }

  let [source] = await db
    .select()
    .from(skillSourcesTable)
    .where(eq(skillSourcesTable.repoUrl, REPO_URL));

  if (!source) {
    [source] = await db
      .insert(skillSourcesTable)
      .values({
        repoUrl: REPO_URL,
        sourceType: "github",
        trustLevel: "reviewed",
        pinnedCommitSha: headSha,
      })
      .returning();
    logger.info({ sourceId: source.id, sha: headSha }, "Created skill source for ui-ux-pro-max-skill");
  } else if (source.pinnedCommitSha === headSha) {
    logger.info({ sha: headSha }, "Design intelligence already up to date (SHA match) — skipping ingest");
    return;
  } else {
    await db
      .update(skillSourcesTable)
      .set({ pinnedCommitSha: headSha })
      .where(eq(skillSourcesTable.id, source.id));
    logger.info({ sourceId: source.id, oldSha: source.pinnedCommitSha, newSha: headSha }, "SHA changed — re-ingesting");
  }

  let tree: GitHubTree;
  try {
    tree = await fetchJson<GitHubTree>(`${API_BASE}/git/trees/HEAD?recursive=1`);
  } catch (err) {
    logger.error({ err }, "Failed to fetch repo tree — aborting design intelligence ingest");
    return;
  }

  const csvItems = tree.tree.filter(
    item =>
      item.type === "blob" &&
      item.path.startsWith(CANONICAL_DATA_PATH) &&
      item.path.endsWith(".csv"),
  );

  logger.info({ count: csvItems.length }, "CSV files found in canonical data path");

  let totalUpserted = 0;

  for (const item of csvItems) {
    const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/HEAD/${item.path}`;
    const category = categoryFromPath(item.path);

    let csvText: string;
    try {
      csvText = await fetchText(rawUrl);
    } catch (err) {
      logger.warn({ err, path: item.path }, "Failed to fetch CSV — skipping");
      continue;
    }

    const rows = parseCsv(csvText);
    if (rows.length === 0) {
      logger.debug({ path: item.path }, "Empty CSV — skipping");
      continue;
    }

    for (const row of rows) {
      const name = rowName(row);
      const tags = tagsFromRow(category, row);

      try {
        await db
          .insert(designIntelligenceEntriesTable)
          .values({
            sourceId: source.id,
            category,
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
        totalUpserted++;
      } catch (err) {
        logger.warn({ err, category, name }, "Failed to upsert design intelligence entry");
      }
    }

    logger.debug({ path: item.path, category, rows: rows.length }, "Ingested CSV");
  }

  logger.info({ totalUpserted, sha: headSha }, "Design intelligence ingest complete");
}
