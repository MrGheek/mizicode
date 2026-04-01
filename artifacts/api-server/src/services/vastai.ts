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

export interface VastSearchResponse {
  offers?: Record<string, unknown>[];
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

export interface VastInstanceListResponse {
  instances?: VastInstance[];
}

export interface VastTemplateResponse {
  template_hash?: string;
  hash_id?: string;
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
  const body: Record<string, unknown> = {
    client_id: "me",
    image: params.image,
    onstart: params.onstart,
    runtype: "args",
    disk: params.disk || 400,
  };

  if (params.env) {
    body.env = params.env;
  }

  if (params.templateHashId) {
    body.template_hash_id = params.templateHashId;
  }

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

export async function getInstance(instanceId: number) {
  return vastFetch<VastInstance>(`/instances/${instanceId}/`);
}

export async function listInstances() {
  const data = await vastFetch<VastInstanceListResponse>("/instances/", {
    method: "GET",
  });
  return data.instances || [];
}

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

export function buildOnStartScript(profileConfig: {
  modelRepo: string;
  modelQuant: string;
  llamaCtxSize: number;
  llamaBatchSize: number;
  llamaExtraArgs: string;
}): string {
  return `#!/bin/bash
export MODEL_REPO="${profileConfig.modelRepo}"
export MODEL_QUANT="${profileConfig.modelQuant}"
export LLAMA_CTX_SIZE="${profileConfig.llamaCtxSize}"
export LLAMA_BATCH_SIZE="${profileConfig.llamaBatchSize}"
export LLAMA_EXTRA_ARGS="${profileConfig.llamaExtraArgs}"
/opt/onstart.sh
`;
}

export function buildInstanceUrls(instance: { public_ipaddr?: string; ports?: Record<string, { HostPort?: string }[]> }) {
  const ip = instance.public_ipaddr;
  if (!ip) return {};

  const ports = instance.ports || {};
  const getPort = (containerPort: string) => {
    const mapping = ports[`${containerPort}/tcp`];
    return mapping?.[0]?.HostPort;
  };

  const boltPort = getPort("5173");
  const codeServerPort = getPort("8080");
  const previewPort = getPort("3000");
  const sshPort = getPort("22");

  return {
    boltDiyUrl: boltPort ? `http://${ip}:${boltPort}` : null,
    codeServerUrl: codeServerPort ? `http://${ip}:${codeServerPort}` : null,
    previewUrl: previewPort ? `http://${ip}:${previewPort}` : null,
    sshHost: ip,
    sshPort: sshPort ? parseInt(sshPort) : null,
    publicIp: ip,
  };
}
