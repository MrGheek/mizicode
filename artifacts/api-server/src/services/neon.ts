import { logger } from "../lib/logger";

const NEON_API_BASE = "https://console.neon.tech/api/v2";

function getNeonConfig(): { apiKey: string; projectId: string } | null {
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  return { apiKey, projectId };
}

function neonHeaders(apiKey: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function neonFetch<T = Record<string, unknown>>(
  path: string,
  apiKey: string,
  opts: RequestInit = {}
): Promise<T> {
  const url = `${NEON_API_BASE}${path}`;
  logger.info({ url, method: opts.method || "GET" }, "Neon API call");
  const res = await fetch(url, {
    ...opts,
    headers: { ...neonHeaders(apiKey), ...(opts.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text, url }, "Neon API error");
    throw new Error(`Neon API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface NeonBranchResult {
  connectionString: string;
  branchId: string;
}

interface NeonBranchResponse {
  branch?: { id: string };
  connection_uris?: { connection_uri: string }[];
}

interface NeonEndpointResponse {
  endpoints?: { id: string; host: string }[];
}

export async function createBranch(
  sessionId: number,
  sqlContent?: string
): Promise<NeonBranchResult> {
  const config = getNeonConfig();
  if (!config) {
    throw new Error("NEON_API_KEY and NEON_PROJECT_ID must be set for Postgres provisioning");
  }
  const { apiKey, projectId } = config;

  const branchName = `mizi-session-${sessionId}-${Date.now()}`;

  const branchData = await neonFetch<NeonBranchResponse>(
    `/projects/${projectId}/branches`,
    apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        branch: { name: branchName },
        endpoints: [{ type: "read_write" }],
      }),
    }
  );

  const branchId = branchData.branch?.id;
  if (!branchId) {
    throw new Error("Neon did not return a branch ID");
  }

  const connectionUri = branchData.connection_uris?.[0]?.connection_uri;
  if (!connectionUri) {
    throw new Error("Neon did not return a connection URI");
  }

  if (sqlContent && sqlContent.trim()) {
    try {
      logger.info({ branchId, sessionId }, "Applying schema template to Neon branch");
      await neonFetch(
        `/projects/${projectId}/queries`,
        apiKey,
        {
          method: "POST",
          body: JSON.stringify({
            query: sqlContent,
            branch_id: branchId,
          }),
        }
      );
      logger.info({ branchId }, "Schema template applied successfully");
    } catch (err) {
      // Schema application failed — clean up the orphaned branch before throwing,
      // so callers receive a clear failure rather than a silently unseeded database.
      logger.error({ err, branchId, sessionId }, "Schema template apply failed — deleting orphaned branch");
      try {
        await neonFetch(`/projects/${projectId}/branches/${branchId}`, apiKey, { method: "DELETE" });
      } catch (deleteErr) {
        logger.warn({ deleteErr, branchId }, "Failed to delete orphaned branch after schema failure (non-fatal)");
      }
      throw new Error(
        `Schema template application failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logger.info({ branchId, sessionId, projectId }, "Neon branch created for session");
  return { connectionString: connectionUri, branchId };
}

export async function deleteBranch(branchId: string): Promise<void> {
  const config = getNeonConfig();
  if (!config) {
    logger.warn({ branchId }, "Neon not configured — skipping branch deletion");
    return;
  }
  const { apiKey, projectId } = config;

  try {
    await neonFetch(
      `/projects/${projectId}/branches/${branchId}`,
      apiKey,
      { method: "DELETE" }
    );
    logger.info({ branchId, projectId }, "Neon branch deleted");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
      logger.warn({ branchId }, "Neon branch already gone — treating as success");
      return;
    }
    throw err;
  }
}

export function isNeonConfigured(): boolean {
  return !!(process.env.NEON_API_KEY && process.env.NEON_PROJECT_ID);
}
