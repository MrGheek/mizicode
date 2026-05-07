/**
 * GitHub PR creation service.
 *
 * Uses the stored OAuth token (loaded via getStoredGitHubToken) to open a draft
 * pull request via the GitHub REST API. All callers must check that a token is
 * available before calling — the function returns null (not throws) when the
 * token is missing, so the handoff flow degrades gracefully.
 *
 * Accepted input:
 *   repoUrl    — full GitHub HTTPS clone URL, e.g. https://github.com/owner/repo
 *   headBranch — source branch (lane branch)
 *   baseBranch — target branch (session branch)
 *   title      — PR title
 *   body       — PR body (markdown)
 *
 * Returns the PR HTML URL on success, or null on any failure.
 */

import { logger } from "../lib/logger";
import { getStoredGitHubToken } from "../routes/auth";

interface CreatePrParams {
  repoUrl: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body?: string;
}

interface GitHubPrResponse {
  html_url?: string;
  number?: number;
  errors?: Array<{ message: string }>;
  message?: string;
}

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.\s]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

export async function createDraftPullRequest(params: CreatePrParams): Promise<string | null> {
  const token = await getStoredGitHubToken();
  if (!token) {
    logger.debug("github-pr: no OAuth token stored — skipping PR creation");
    return null;
  }

  const parsed = parseOwnerRepo(params.repoUrl);
  if (!parsed) {
    logger.warn({ repoUrl: params.repoUrl }, "github-pr: could not parse owner/repo from URL — skipping PR creation");
    return null;
  }

  const { owner, repo } = parsed;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: params.title,
        body: params.body ?? "",
        head: params.headBranch,
        base: params.baseBranch,
        draft: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await res.json() as GitHubPrResponse;

    if (!res.ok) {
      const msg = data.message ?? (data.errors?.[0]?.message ?? `HTTP ${res.status}`);
      logger.warn({ owner, repo, headBranch: params.headBranch, status: res.status, msg }, "github-pr: PR creation failed");
      return null;
    }

    if (!data.html_url) {
      logger.warn({ owner, repo }, "github-pr: PR created but no html_url in response");
      return null;
    }

    logger.info({ owner, repo, prNumber: data.number, headBranch: params.headBranch, baseBranch: params.baseBranch }, "github-pr: draft PR created");
    return data.html_url;
  } catch (err) {
    logger.warn({ err, owner, repo }, "github-pr: error calling GitHub API — skipping PR creation");
    return null;
  }
}
