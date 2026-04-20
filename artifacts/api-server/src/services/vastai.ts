import { logger } from "../lib/logger";

const VASTAI_BASE = "https://cloud.vast.ai/api/v0";

function getApiKey(): string {
  const key = process.env.VASTAI_API_KEY;
  if (!key) throw new Error("VASTAI_API_KEY not set");
  return key;
}

function headers() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey()}`,
  };
}

async function vastFetch<T = Record<string, unknown>>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = `${VASTAI_BASE}${path}`;
  logger.info({ url, method: opts.method || "GET" }, "Vast.ai API call");
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...opts.headers } });
  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text, url }, "Vast.ai API error");
    throw new Error(`Vast.ai API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface VastOffer {
  id: number;
  gpu_name?: string;
  num_gpus?: number;
  gpu_ram?: number;
  cpu_cores?: number;
  cpu_name?: string;
  disk_space?: number;
  inet_down?: number;
  inet_up?: number;
  dph_total?: number;
  dlperf?: number;
  reliability?: number;
  geolocation?: string;
  rentable?: boolean;
  rented?: boolean;
  verification?: string;
  [key: string]: unknown;
}

export interface VastSearchResponse {
  offers?: VastOffer[];
}

export interface VastInstanceResponse {
  new_contract?: number;
  expected_price?: number;
}

export interface VastInstance {
  public_ipaddr?: string;
  ports?: Record<string, { HostPort?: string }[]>;
  actual_status?: string;
  status_msg?: string;
}

export interface VastInstanceGetResponse {
  instances?: VastInstance;
}

export interface VastInstanceListResponse {
  instances?: VastInstance[];
}

export interface VastTemplateResponse {
  success?: boolean;
  template_hash?: string;
  hash_id?: string;
  template?: {
    hash_id?: string;
    id?: number;
    name?: string;
  };
}

export interface VastSearchParams {
  gpu_name?: string;
  num_gpus?: number;
  min_gpu_ram?: number;
  disk_space?: number;
  order?: string;
  limit?: number;
  type?: string;
  extra?: Record<string, unknown>;
}

export async function searchOffers(params: VastSearchParams) {
  const query: Record<string, unknown> = {
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    type: params.type || "ask",
    order: [[params.order || "dph_total", "asc"]],
    limit: params.limit || 20,
  };

  if (params.gpu_name) {
    query.gpu_name = { eq: params.gpu_name };
  }
  if (params.num_gpus) {
    query.num_gpus = { gte: params.num_gpus };
  }
  if (params.min_gpu_ram) {
    query.gpu_ram = { gte: params.min_gpu_ram };
  }
  if (params.disk_space) {
    query.disk_space = { gte: params.disk_space };
  }
  if (params.extra) {
    Object.assign(query, params.extra);
  }

  const data = await vastFetch<VastSearchResponse>("/bundles/", {
    method: "POST",
    body: JSON.stringify(query),
  });

  return data.offers || [];
}

export interface VastCreateInstanceParams {
  offerId: number;
  image: string;
  onstart: string;
  env?: Record<string, string>;
  disk?: number;
  templateHashId?: string;
}

export async function createInstance(params: VastCreateInstanceParams) {
  // Vast.ai env dict uses Docker run-flag format:
  //   "-p HOST:CONTAINER"  → port mapping
  //   "-e KEY=VALUE"       → environment variable
  const envDict: Record<string, string> = {
    "-p 22:22": "1",
    "-p 3000:3000": "1",
    "-p 5180:5180": "1",
    "-p 5181:5181": "1",
    "-p 8080:8080": "1",
    "-p 8081:8081": "1",
  };

  if (params.env) {
    for (const [key, value] of Object.entries(params.env)) {
      envDict[`-e ${key}=${value}`] = "1";
    }
  }

  const body: Record<string, unknown> = {
    client_id: "me",
    image: params.image,
    onstart: params.onstart,
    runtype: "ssh_proxy",
    disk: params.disk || 400,
    env: envDict,
  };

  // Note: template_hash_id is intentionally omitted — Vast.ai rejects instance
  // creation with an unrecognised hash. image + onstart + env are sufficient.

  return vastFetch<VastInstanceResponse>(`/asks/${params.offerId}/`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function destroyInstance(instanceId: number) {
  return vastFetch(`/instances/${instanceId}/`, {
    method: "DELETE",
  });
}

export async function getInstance(instanceId: number): Promise<VastInstance> {
  const data = await vastFetch<VastInstanceGetResponse>(`/instances/${instanceId}/`);
  // Vast.ai wraps single-instance GET in { instances: { ... } } (object, not array)
  return (data.instances as VastInstance) || data as unknown as VastInstance;
}

export async function listInstances() {
  const data = await vastFetch<VastInstanceListResponse>("/instances/", {
    method: "GET",
  });
  return data.instances || [];
}

// ─── Template management ──────────────────────────────────────────────────────

export interface VastTemplateParams {
  name: string;
  image_tag: string;
  onstart: string;
  env?: string;
  disk_space?: number;
  readme?: string;
}

export async function createTemplate(params: VastTemplateParams) {
  const body = {
    name: params.name,
    image_tag: params.image_tag,
    onstart: params.onstart,
    env: params.env || "",
    disk_space: params.disk_space || 400,
    readme: params.readme || "",
    tag_name: "omniql-coding",
    allow_ssh: true,
  };

  return vastFetch<VastTemplateResponse>("/template/", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteTemplate(templateHash: string) {
  return vastFetch(`/template/${templateHash}/`, {
    method: "DELETE",
  });
}

export async function getTemplate(templateHash: string) {
  return vastFetch(`/template/${templateHash}/`);
}

export interface VastTemplateListResponse {
  templates?: Record<string, unknown>[];
}

export async function listTemplates() {
  const data = await vastFetch<VastTemplateListResponse>("/templates/");
  return data.templates || [];
}

export async function updateTemplate(oldHash: string, params: VastTemplateParams): Promise<VastTemplateResponse> {
  await deleteTemplate(oldHash).catch(() => {});
  return createTemplate(params);
}

// ─── On-start script builder ──────────────────────────────────────────────────

export interface TeamMemberInput {
  name: string;
  password: string;
  path: string;
}

export function buildOnStartScript(profileConfig: {
  modelRepo: string;
  modelQuant: string;
  servedModelName: string;
  llamaCtxSize: number;
  llamaBatchSize: number;
  llamaExtraArgs: string;
  numGpus?: number;
  memProxyUrl?: string;
  memAuthToken?: string;
  memUserId?: string;
  teamMembers?: TeamMemberInput[];
  sessionId?: number;
  callbackBaseUrl?: string;
}): string {
  const memLines = profileConfig.memProxyUrl
    ? [
        `export OMNIQL_MEM_PROXY_URL="${profileConfig.memProxyUrl}"`,
        `export OMNIQL_MEM_AUTH_TOKEN="${profileConfig.memAuthToken || ""}"`,
        `export OMNIQL_MEM_USER_ID="${profileConfig.memUserId || "default"}"`,
      ].join("\n")
    : "";

  // Callback: instance posts phase transitions to the API server so the dashboard
  // can track boot progress without needing to probe the instance (firewall blocks it).
  const callbackLines = profileConfig.callbackBaseUrl && profileConfig.sessionId != null
    ? [
        `export OMNIQL_SESSION_ID="${profileConfig.sessionId}"`,
        `export OMNIQL_CALLBACK_URL="${profileConfig.callbackBaseUrl}/api/sessions/${profileConfig.sessionId}/status"`,
      ].join("\n")
    : "";

  // Single-quoted so bash does not expand anything inside the JSON value.
  // Passwords use [A-Za-z0-9] only so they never contain single-quotes.
  const teamLine = profileConfig.teamMembers && profileConfig.teamMembers.length > 0
    ? `export TEAM_MEMBERS_JSON='${JSON.stringify(profileConfig.teamMembers)}'`
    : "";

  return `#!/bin/bash
export MODEL_REPO="${profileConfig.modelRepo}"
export MODEL_QUANT="${profileConfig.modelQuant}"
export SERVED_MODEL_NAME="${profileConfig.servedModelName}"
export VLLM_MAX_MODEL_LEN="${profileConfig.llamaCtxSize}"
export VLLM_MAX_NUM_SEQS="${profileConfig.llamaBatchSize}"
export VLLM_EXTRA_ARGS="${profileConfig.llamaExtraArgs}"
export NUM_GPUS="${profileConfig.numGpus || 1}"
${memLines}
${callbackLines}
${teamLine}
/opt/onstart.sh
`;
}

// ─── URL builder ─────────────────────────────────────────────────────────────

export function buildInstanceUrls(instance: { public_ipaddr?: string; ports?: Record<string, { HostPort?: string }[]> }) {
  const ip = instance.public_ipaddr;
  if (!ip) return {};

  const ports = instance.ports || {};
  const getPort = (containerPort: string) => {
    const mapping = ports[`${containerPort}/tcp`];
    return mapping?.[0]?.HostPort;
  };

  const boltPort = getPort("5180");
  const codeServerPort = getPort("8080");
  const previewPort = getPort("3000");
  const sshPort = getPort("22");

  const llmProxyPort = getPort("8081");

  return {
    boltDiyUrl: boltPort ? `http://${ip}:${boltPort}` : null,
    codeServerUrl: codeServerPort ? `http://${ip}:${codeServerPort}` : null,
    llmProxyUrl: llmProxyPort ? `http://${ip}:${llmProxyPort}` : null,
    previewUrl: previewPort ? `http://${ip}:${previewPort}` : null,
    sshHost: ip,
    sshPort: sshPort ? parseInt(sshPort) : null,
    publicIp: ip,
  };
}
