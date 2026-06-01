import crypto from "crypto";
import { db, skillSourcesTable, skillsTable, skillVersionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { normalizeSource } from "./skills-normalizer";
import { logger } from "../lib/logger";
import type { MiziSkillManifest } from "./skills-types";

const CANDIDATE_PATHS = ["SKILL.md", "CLAUDE.md", "AGENTS.md", "README.md"];
const SKILL_DIR_PATHS = ["skills/", "commands/"];

function ownerRepo(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

async function githubFetch(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`https://api.github.com${path}`, { headers });
}

async function resolveCommitSha(owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}/commits/${branch}`);
    if (!res.ok) return null;
    const data = await res.json() as { sha?: string };
    return data.sha || null;
  } catch {
    return null;
  }
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}`);
    if (!res.ok) return "main";
    const data = await res.json() as { default_branch?: string };
    return data.default_branch || "main";
  } catch {
    return "main";
  }
}

async function resolveLicense(owner: string, repo: string): Promise<string | null> {
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}/license`);
    if (!res.ok) return null;
    const data = await res.json() as { license?: { spdx_id?: string } };
    return data.license?.spdx_id || null;
  } catch {
    return null;
  }
}

async function fetchRawFile(owner: string, repo: string, branch: string, path: string): Promise<string | null> {
  try {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

/**
 * Enumerate skill-relevant file paths from a GitHub repo using the Git Trees API.
 *
 * Uses `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` which returns
 * every blob path in the repo in a single, deterministic response — no
 * pagination, no per_page guessing, and no repeated requests needed even for
 * repos with thousands of files (e.g. ECC with 249 skill subdirectories).
 *
 * Matched paths:
 *  - Root-level candidate files: SKILL.md, CLAUDE.md, AGENTS.md, README.md
 *  - Flat files under SKILL_DIR_PATHS: skills/*.md, commands/*.md
 *  - One-level subdirectory skill files: skills/*\/SKILL.md, skills/*\/CLAUDE.md,
 *    commands/*\/SKILL.md, commands/*\/CLAUDE.md
 *
 * Returns an ordered list of unique paths with root-level candidates first.
 */
async function listSkillPaths(owner: string, repo: string, treeSha: string): Promise<string[]> {
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
    if (!res.ok) return [];
    const data = await res.json() as {
      tree?: { path?: string; type?: string }[];
      truncated?: boolean;
    };
    if (!data.tree) return [];

    const blobs = data.tree
      .filter(e => e.type === "blob" && typeof e.path === "string")
      .map(e => e.path as string);

    const seen = new Set<string>();
    const paths: string[] = [];

    function add(p: string) {
      if (!seen.has(p)) { seen.add(p); paths.push(p); }
    }

    // 1. Root-level candidate files
    for (const candidate of CANDIDATE_PATHS) {
      if (blobs.includes(candidate)) add(candidate);
    }

    // 2. Flat files directly inside SKILL_DIR_PATHS (e.g. commands/my-command.md)
    for (const dir of SKILL_DIR_PATHS) {
      const prefix = dir; // already ends with "/"
      for (const p of blobs) {
        if (p.startsWith(prefix) && /\.(md|yaml|yml)$/i.test(p)) {
          const rel = p.slice(prefix.length);
          if (!rel.includes("/")) add(p); // flat file, not inside a subdirectory
        }
      }
    }

    // 3. One-level subdirectory skill files (e.g. skills/flutter-patterns/SKILL.md)
    const SUBDIR_FILENAMES = ["SKILL.md", "CLAUDE.md", "AGENTS.md"];
    for (const dir of SKILL_DIR_PATHS) {
      const prefix = dir;
      for (const p of blobs) {
        if (!p.startsWith(prefix)) continue;
        const rel = p.slice(prefix.length);
        const parts = rel.split("/");
        // Exactly one subdirectory level: skills/<name>/SKILL.md
        if (parts.length === 2 && SUBDIR_FILENAMES.includes(parts[1])) {
          add(p);
        }
      }
    }

    return paths;
  } catch {
    return [];
  }
}

export interface ImportResult {
  source: typeof skillSourcesTable.$inferSelect;
  skills: (typeof skillsTable.$inferSelect)[];
}

export async function importSkillFromUrl(url: string): Promise<ImportResult> {
  const parsed = ownerRepo(url);
  if (!parsed) throw new Error(`Cannot parse GitHub URL: ${url}`);
  const { owner, repo } = parsed;

  const branch = await resolveDefaultBranch(owner, repo);
  const commitSha = await resolveCommitSha(owner, repo, branch);
  const license = await resolveLicense(owner, repo);

  const rawFiles: { path: string; content: string }[] = [];

  // Use the Git Trees API to enumerate all skill-relevant paths in one request.
  // This is deterministic regardless of repo size — no pagination loops needed.
  if (commitSha) {
    const skillPaths = await listSkillPaths(owner, repo, commitSha);
    for (const filePath of skillPaths) {
      const content = await fetchRawFile(owner, repo, branch, filePath);
      if (content) rawFiles.push({ path: filePath, content });
    }
  } else {
    // Fallback: commitSha unavailable, probe known candidate paths directly
    for (const candidate of CANDIDATE_PATHS) {
      const content = await fetchRawFile(owner, repo, branch, candidate);
      if (content) rawFiles.push({ path: candidate, content });
    }
  }

  if (rawFiles.length === 0) {
    throw new Error(`No skill files found in repo ${owner}/${repo}. Expected SKILL.md, CLAUDE.md, AGENTS.md, or skills/ directory.`);
  }

  const [source] = await db.insert(skillSourcesTable).values({
    repoUrl: url,
    sourceType: "github",
    defaultBranch: branch,
    pinnedCommitSha: commitSha,
    license,
    trustLevel: "user_approved",
  }).returning();

  const dummySource = { ...source };
  const manifests = normalizeSource(rawFiles, dummySource);
  logger.info({ url, fileCount: rawFiles.length, manifestCount: manifests.length }, "Skills normalized from repo");

  const createdSkills: (typeof skillsTable.$inferSelect)[] = [];

  for (const manifest of manifests) {
    const installRisk = manifest.install.type;
    const trustTier = installRisk === "hooked" || installRisk === "binary" ? "experimental" : "user_approved";

    const versionHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex")
      .slice(0, 16);

    const [skill] = await db.insert(skillsTable).values({
      slug: `imported-${source.id}-${manifest.id}`,
      name: manifest.name,
      class: manifest.class,
      description: manifest.summary,
      sourceId: source.id,
      trustTier,
      installRisk: manifest.install.type,
      tokenOverheadEstimate: manifest.cost.tokenOverheadEstimate,
      enabled: false,
      reviewStatus: "pending",
    }).returning();

    await db.insert(skillVersionsTable).values({
      skillId: skill.id,
      manifestJson: manifest as unknown as Record<string, unknown>,
      extractedRulesJson: { rules: manifest.instructions.system } as unknown as Record<string, unknown>,
      sourceFilesJson: { files: rawFiles.map(f => f.path) } as unknown as Record<string, unknown>,
      versionHash,
    });

    createdSkills.push(skill);
  }

  return { source, skills: createdSkills };
}

export async function getLatestManifestForSkill(skillId: number): Promise<MiziSkillManifest | null> {
  const [version] = await db
    .select()
    .from(skillVersionsTable)
    .where(eq(skillVersionsTable.skillId, skillId))
    .orderBy(desc(skillVersionsTable.createdAt))
    .limit(1);

  if (!version) return null;
  return version.manifestJson as unknown as MiziSkillManifest;
}
