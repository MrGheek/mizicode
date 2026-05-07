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
  dph_total?: number;
  dph_base?: number;
  cost_run_time?: number;
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
    tag_name: "mizi-coding",
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
  // Maximum concurrent swarm workers for this instance, sourced from the profile's
  // swarmWorkerCap field. Exported as SWARM_MAX_WORKERS so the Claw Runner can
  // enforce the cap without needing to know which model is running.
  // 0 means no cap / swarm not configured.
  swarmWorkerCap?: number | null;
  memProxyUrl?: string;
  memAuthToken?: string;
  memUserId?: string;
  teamMembers?: TeamMemberInput[];
  sessionId?: number;
  callbackBaseUrl?: string;
  activeBundleB64?: string;
  // NIM hosted-inference mode: when set, onstart.sh skips vLLM/download and
  // routes LiteLLM at the partner API endpoint instead.
  nimModelId?: string;
  nimApiBase?: string;
  nimApiKey?: string;
  // Swarm-specific model override: when phase-aware auto-routing is enabled, the
  // orchestrator picks a separate economy model for swarm workers to maximise
  // throughput while keeping orchestrator quality high. Exported as SWARM_MODEL_ID
  // and SWARM_PROVIDER so the Claw Runner can forward them to worker agents.
  // swarmApiBase/swarmApiKey are the resolved provider credentials for the swarm
  // model — critical when swarm uses a different provider than the orchestrator,
  // since onstart.sh uses them for the LiteLLM "swarm" route (not orchestrator creds).
  swarmModelId?: string;
  swarmProvider?: string;
  swarmApiBase?: string;
  swarmApiKey?: string;
  // GitHub PAT: injected as GITHUB_TOKEN. When set, git is configured to use
  // the token for HTTPS github.com operations and all pushes are redirected to
  // a dedicated session branch (mizi/session-<id>) via a git wrapper script.
  // The token is never stored in the DB — only ever passed through the onstart script.
  githubToken?: string;
}): string {
  const memLines = profileConfig.memProxyUrl
    ? [
        `export MIZI_MEM_PROXY_URL="${profileConfig.memProxyUrl}"`,
        `export MIZI_MEM_AUTH_TOKEN="${profileConfig.memAuthToken || ""}"`,
        `export MIZI_MEM_USER_ID="${profileConfig.memUserId || "default"}"`,
      ].join("\n")
    : "";

  // Callback: instance posts phase transitions to the API server so the dashboard
  // can track boot progress without needing to probe the instance (firewall blocks it).
  const callbackLines = profileConfig.callbackBaseUrl && profileConfig.sessionId != null
    ? [
        `export MIZI_SESSION_ID="${profileConfig.sessionId}"`,
        `export MIZI_CALLBACK_URL="${profileConfig.callbackBaseUrl}/api/sessions/${profileConfig.sessionId}/status"`,
      ].join("\n")
    : "";

  // Single-quoted so bash does not expand anything inside the JSON value.
  // Passwords use [A-Za-z0-9] only so they never contain single-quotes.
  const teamLine = profileConfig.teamMembers && profileConfig.teamMembers.length > 0
    ? `export TEAM_MEMBERS_JSON='${JSON.stringify(profileConfig.teamMembers)}'`
    : "";

  // Smart Skills bundle: written to /workspace/.mizi/skills/active-bundle.json during boot.
  // The base64 payload contains the compiled bundle + system prompt fragment.
  const skillsLine = profileConfig.activeBundleB64
    ? `export MIZI_ACTIVE_BUNDLE_B64='${profileConfig.activeBundleB64}'`
    : "";

  const nimLines = profileConfig.nimModelId
    ? [
        `export NIM_MODEL_ID="${profileConfig.nimModelId}"`,
        `export NIM_API_BASE="${profileConfig.nimApiBase || "https://integrate.api.nvidia.com/v1"}"`,
        `export NIM_API_KEY="${profileConfig.nimApiKey || ""}"`,
        // Swarm-specific model override for economy/throughput-optimised workers.
        // Includes provider-specific API credentials so the LiteLLM "swarm" route
        // uses the correct upstream even when swarm uses a different provider than
        // the orchestrator (e.g. DeepInfra swarm + NVIDIA orchestrator).
        profileConfig.swarmModelId
          ? [
              `export SWARM_MODEL_ID="${profileConfig.swarmModelId}"`,
              `export SWARM_PROVIDER="${profileConfig.swarmProvider || "nvidia"}"`,
              profileConfig.swarmApiBase ? `export SWARM_API_BASE="${profileConfig.swarmApiBase}"` : "",
              profileConfig.swarmApiKey ? `export SWARM_API_KEY="${profileConfig.swarmApiKey}"` : "",
            ].filter(Boolean).join("\n")
          : "",
        // Install the hot-reload script so PATCH /sessions/:id/model can live-swap
        // the active LiteLLM model without restarting the Fly machine.
        // Called via Fly exec API with env vars LITELLM_MODEL_ID + LITELLM_PROVIDER.
        // The script writes a fresh litellm_config.yaml and sends SIGHUP to litellm.
        `mkdir -p /opt/mizi`,
        `cat > /opt/mizi/reload-model.sh << 'MIZI_RELOAD_EOF'`,
        `#!/bin/bash`,
        `set -euo pipefail`,
        `MODEL_ID="\${LITELLM_MODEL_ID:-}"`,
        `PROVIDER="\${LITELLM_PROVIDER:-}"`,
        `[ -z "$MODEL_ID" ] && { echo "LITELLM_MODEL_ID not set" >&2; exit 1; }`,
        `[ -z "$PROVIDER" ] && { echo "LITELLM_PROVIDER not set" >&2; exit 1; }`,
        `# Use switch-time credentials passed by the API server (not launch-time env).`,
        `# LITELLM_API_BASE and LITELLM_API_KEY are set per-provider by sessions.ts.`,
        `API_BASE="\${LITELLM_API_BASE:-https://integrate.api.nvidia.com/v1}"`,
        `API_KEY="\${LITELLM_API_KEY:-}"`,
        `# Rewrite the LiteLLM proxy config so it routes to the new model/provider.`,
        `# litellm watches /opt/mizi/litellm_config.yaml and reloads on SIGHUP.`,
        `# Model is always prefixed with "openai/" — LiteLLM uses api_base/api_key`,
        `# to determine the actual upstream; the prefix just selects the SDK codec.`,
        `#`,
        `# Dual-model config: if SWARM_MODEL_ID is set (injected at session launch),`,
        `# a second model_name "swarm" entry is appended so swarm workers can route`,
        `# to their economy model independently of the orchestrator "default" model.`,
        `# The orchestrator model uses the new model/provider; swarm keeps its own.`,
        `SWARM_SECTION=""`,
        `if [ -n "\${SWARM_MODEL_ID:-}" ]; then`,
        `  SWARM_API_BASE="\${SWARM_API_BASE:-https://integrate.api.nvidia.com/v1}"`,
        `  SWARM_API_KEY="\${SWARM_API_KEY:-}"`,
        `  SWARM_SECTION=$(cat << SWARM_EOF`,
        `  - model_name: swarm`,
        `    litellm_params:`,
        `      model: "openai/\${SWARM_MODEL_ID}"`,
        `      api_base: "\${SWARM_API_BASE}"`,
        `      api_key: "\${SWARM_API_KEY}"`,
        `SWARM_EOF`,
        `)`,
        `fi`,
        `cat > /opt/mizi/litellm_config.yaml << LITELLM_YAML`,
        `model_list:`,
        `  - model_name: default`,
        `    litellm_params:`,
        `      model: "openai/\${MODEL_ID}"`,
        `      api_base: "\${API_BASE}"`,
        `      api_key: "\${API_KEY}"`,
        `\${SWARM_SECTION}`,
        `LITELLM_YAML`,
        `# Signal litellm to reload config; SIGHUP triggers graceful config reload.`,
        `pkill -HUP -f "litellm" 2>/dev/null || true`,
        `echo "Reload complete: openai/\${MODEL_ID} via \${PROVIDER} (\${API_BASE})"`,
        `MIZI_RELOAD_EOF`,
        `chmod +x /opt/mizi/reload-model.sh`,
      ].filter(Boolean).join("\n")
    : "";

  // GitHub PAT: configure git credential substitution and install a lightweight
  // git wrapper that redirects all `git push` calls to the session-specific branch
  // (mizi/session-<id>). The wrapper is placed at /usr/local/bin/git which is
  // ahead of /usr/bin/git in PATH. All non-push commands pass through unchanged.
  //
  // Security note: the token is injected only into the onstart script (passed
  // in-memory to Vast.ai, not stored in any DB column). The heredoc uses a
  // single-quoted delimiter so the wrapper's $-variables are written literally
  // and only evaluated when the wrapper itself is called later.
  const githubLines = profileConfig.githubToken && profileConfig.sessionId != null
    ? `export GITHUB_TOKEN="${profileConfig.githubToken}"
git config --global url."https://${profileConfig.githubToken}@github.com/".insteadOf "https://github.com/"
git config --global push.default current
# Install git wrapper — forces all pushes to mizi/session-${profileConfig.sessionId}
cat > /usr/local/bin/git << 'MIZI_GIT_WRAPPER'
#!/bin/bash
GIT=/usr/bin/git
# Walk args skipping global git options to find the actual subcommand.
# Handles: git -c k=v push, git --no-pager push, git -C path push, etc.
CMD=""
SKIP_NEXT=0
for arg in "$@"; do
  if [ "$SKIP_NEXT" = "1" ]; then SKIP_NEXT=0; continue; fi
  case "$arg" in
    -c|-C|--exec-path|--git-dir|--work-tree|--namespace|--super-prefix) SKIP_NEXT=1 ;;
    --*=*|-*) ;;
    *) CMD="$arg"; break ;;
  esac
done
if [ "$CMD" = "push" ]; then
  REMOTE="origin"
  FOUND=0
  SKIP2=0
  for a in "$@"; do
    if [ "$SKIP2" = "1" ]; then SKIP2=0; continue; fi
    case "$a" in
      -c|-C|--exec-path|--git-dir|--work-tree|--namespace|--super-prefix) SKIP2=1; continue ;;
      --*=*|-*) continue ;;
      *)
        if [ "$FOUND" = "1" ]; then REMOTE="$a"; break; fi
        FOUND=1 ;;
    esac
  done
  exec "$GIT" push "$REMOTE" HEAD:mizi/session-${profileConfig.sessionId}
else
  exec "$GIT" "$@"
fi
MIZI_GIT_WRAPPER
chmod +x /usr/local/bin/git`
    : "";

  return `#!/bin/bash
export MODEL_REPO="${profileConfig.modelRepo}"
export MODEL_QUANT="${profileConfig.modelQuant}"
export SERVED_MODEL_NAME="${profileConfig.servedModelName}"
export VLLM_MAX_MODEL_LEN="${profileConfig.llamaCtxSize}"
export VLLM_MAX_NUM_SEQS="${profileConfig.llamaBatchSize}"
export VLLM_EXTRA_ARGS="${profileConfig.llamaExtraArgs}"
export NUM_GPUS="${profileConfig.numGpus || 1}"
export SWARM_MAX_WORKERS="${profileConfig.swarmWorkerCap ?? 0}"
${nimLines}
${memLines}
${callbackLines}
${teamLine}
${skillsLine}
${githubLines}
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
