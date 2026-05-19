import { logger } from "../lib/logger";

const TIGRIS_API_BASE = "https://api.tigris.dev/v1";

function getTigrisConfig(): { token: string } | null {
  const token = process.env.TIGRIS_TOKEN || process.env.FLY_API_TOKEN;
  if (!token) return null;
  return { token };
}

function tigrisHeaders(token: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function tigrisFetch<T = Record<string, unknown>>(
  path: string,
  token: string,
  opts: RequestInit = {}
): Promise<T> {
  const url = `${TIGRIS_API_BASE}${path}`;
  logger.info({ url, method: opts.method || "GET" }, "Tigris API call");
  const res = await fetch(url, {
    ...opts,
    headers: { ...tigrisHeaders(token), ...(opts.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text, url }, "Tigris API error");
    throw new Error(`Tigris API error ${res.status}: ${text}`);
  }
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return {} as T;
  }
  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

export interface TigrisBucketResult {
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string;
}

interface TigrisCreateBucketResponse {
  bucket?: {
    name?: string;
    access_key_id?: string;
    secret_access_key?: string;
    endpoint_url?: string;
    region?: string;
  };
}

export async function createBucket(sessionId: number): Promise<TigrisBucketResult> {
  const config = getTigrisConfig();
  if (!config) {
    throw new Error("TIGRIS_TOKEN (or FLY_API_TOKEN) must be set for storage provisioning");
  }
  const { token } = config;

  const bucketName = `mizi-session-${sessionId}-${Date.now()}`;

  const data = await tigrisFetch<TigrisCreateBucketResponse>(
    "/buckets",
    token,
    {
      method: "POST",
      body: JSON.stringify({ name: bucketName }),
    }
  );

  const bucket = data.bucket;
  if (!bucket?.name) {
    throw new Error("Tigris did not return a bucket name");
  }
  if (!bucket.access_key_id || !bucket.secret_access_key) {
    throw new Error("Tigris did not return bucket credentials");
  }

  const endpoint = bucket.endpoint_url ?? "https://fly.storage.tigris.dev";
  const region = bucket.region ?? "auto";

  logger.info({ bucketName: bucket.name, sessionId }, "Tigris bucket created for session");

  return {
    bucketName: bucket.name,
    accessKeyId: bucket.access_key_id,
    secretAccessKey: bucket.secret_access_key,
    endpoint,
    region,
  };
}

export async function deleteBucket(bucketName: string): Promise<void> {
  const config = getTigrisConfig();
  if (!config) {
    logger.warn({ bucketName }, "Tigris not configured — skipping bucket deletion");
    return;
  }
  const { token } = config;

  try {
    await tigrisFetch(
      `/buckets/${encodeURIComponent(bucketName)}`,
      token,
      { method: "DELETE" }
    );
    logger.info({ bucketName }, "Tigris bucket deleted");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
      logger.warn({ bucketName }, "Tigris bucket already gone — treating as success");
      return;
    }
    throw err;
  }
}

export function isTigrisConfigured(): boolean {
  return !!(process.env.TIGRIS_TOKEN || process.env.FLY_API_TOKEN);
}
