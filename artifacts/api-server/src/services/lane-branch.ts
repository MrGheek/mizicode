/**
 * Lane branch name helpers.
 *
 * Each lane gets a sub-branch under the session branch:
 *   mizi/session-{sessionId}/{laneSlug}
 *
 * The session branch itself (base for all lane PRs) is:
 *   mizi/session-{sessionId}
 *
 * Lane slugs are derived from the member identifier which is already constrained
 * to [a-z0-9_-] by the session creation handler, so no additional sanitisation
 * is required.
 */

export function getSessionBranchName(sessionId: number): string {
  return `mizi/session-${sessionId}`;
}

export function getLaneBranchName(sessionId: number, memberIdentifier: string): string {
  const slug = memberIdentifier.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 50);
  return `mizi/session-${sessionId}/${slug}`;
}
