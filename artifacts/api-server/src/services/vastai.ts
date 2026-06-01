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
  // When true (and githubToken is set), each team member's pushes are redirected
  // to a per-lane sub-branch (mizi/session-<id>/<username>) instead of the shared
  // session branch. Defaults to true when a GitHub token is available.
  enableLaneBranches?: boolean;
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
  // MIZI_MEM_AUTH_TOKEN must be included here (not just in memLines) because NIM
  // sessions never set memProxyUrl, so memLines is empty — but the API server still
  // enforces MIZI_MEM_TOKEN on the /status callback endpoint in production.
  const callbackLines = profileConfig.callbackBaseUrl && profileConfig.sessionId != null
    ? [
        `export MIZI_SESSION_ID="${profileConfig.sessionId}"`,
        `export MIZI_CALLBACK_URL="${profileConfig.callbackBaseUrl}/api/sessions/${profileConfig.sessionId}/status"`,
        `export MIZI_MEM_AUTH_TOKEN="${profileConfig.memAuthToken || ""}"`,
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
        // VLLM_PORT must be exported so onstart.sh probes the right port.
        // nim-proxy.py defaults to 8081 — keep in sync with Fly services config.
        `export VLLM_PORT="8081"`,
        // Fly's hallpass SSH proxy always tries to bind port 22 inside the microVM.
        // The container's sshd also starts on port 22 (onstart.sh line ~172), causing
        // hallpass to crash-loop and eventually panic the entire machine.
        // Fix: move sshd to port 2222 BEFORE onstart.sh starts it so hallpass wins port 22.
        // NIM sessions don't need external SSH — users connect via bolt.diy (5180).
        `sed -i '/^#*Port /d' /etc/ssh/sshd_config 2>/dev/null || true`,
        `echo "Port 2222" >> /etc/ssh/sshd_config 2>/dev/null || true`,
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
  // When enableLaneBranches is true (default when token is present), the git
  // wrapper pushes each user to their own sub-branch: mizi/session-<id>/$USER.
  // When false, all users push to the shared session branch: mizi/session-<id>.
  const laneBranchesEnabled = profileConfig.enableLaneBranches !== false;
  const pushTarget = laneBranchesEnabled
    ? `mizi/session-${profileConfig.sessionId}/$USER`
    : `mizi/session-${profileConfig.sessionId}`;
  const laneBranchExport = laneBranchesEnabled
    ? `export GITHUB_LANE_BRANCHES_ENABLED=1`
    : "";

  // Bridge: outbound WebSocket from the machine to the MIZI API server.
  // Allows the dashboard to deliver prompts to claw-runner without inbound firewall access.
  // MIZI_BRIDGE_URL is the full wss:// URL (session + lane embedded).
  // laneId=0 is the primary lane; getBridgeForSession falls back to lowest laneId,
  // so laneId=0 is always reachable even when the registry checks laneId=1 first.
  const bridgeLines = profileConfig.callbackBaseUrl && profileConfig.sessionId != null
    ? [
        `export MIZI_BRIDGE_URL="${profileConfig.callbackBaseUrl.replace(/^https/, "wss")}/api/bridge/${profileConfig.sessionId}/0?token=${profileConfig.memAuthToken || ""}"`,
        `export MIZI_LANE_ID="0"`,
      ].join("\n")
    : "";

  const githubLines = profileConfig.githubToken && profileConfig.sessionId != null
    ? `export GITHUB_TOKEN="${profileConfig.githubToken}"
${laneBranchExport}
git config --global url."https://${profileConfig.githubToken}@github.com/".insteadOf "https://github.com/"
git config --global push.default current
# Install git wrapper — forces all pushes to the session or lane branch
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
  exec "$GIT" push "$REMOTE" HEAD:${pushTarget}
else
  exec "$GIT" "$@"
fi
MIZI_GIT_WRAPPER
chmod +x /usr/local/bin/git`
    : "";

  // Bolt.diy gate + pre-warm: polls localhost:5173 until Vite responds, then
  // sends bolt_ready to unlock "Open Coding Environment" in the dashboard.
  //
  // The API server intercepts the llm_ready callback (sent by onstart.sh when
  // the NIM proxy comes up) and keeps the session in "starting" state for NIM
  // sessions.  This gate is the only thing that can move it to "ready", so the
  // button stays locked until bolt.diy has actually finished its first compile.
  //
  // Timeline on shared-cpu-1x:
  //   t=0   — gate background job starts
  //   t=30  — bolt.diy pnpm-dev server starts (Phase 1 of onstart.sh)
  //   t=60  — NIM proxy ready → llm_ready → intercepted → "starting/compiling"
  //   t=?   — Vite responds to first HTTP request (2-4 min compile)
  //   t=?   — bolt_ready sent → session moves to "ready" → button unlocks
  //
  // Progress pings every 60 s keep the boot log alive so the user sees
  // compilation is in progress rather than a stale "compiling" message.
  const nimBoltWarmupLines = profileConfig.nimModelId && profileConfig.callbackBaseUrl && profileConfig.sessionId != null
    ? `# Bolt.diy gate — two phases:
#   Phase 1: poll :5173 until Vite is up (first 200).
#   Phase 2: wait for /opt/bolt-diy/node_modules/.vite/deps/_metadata.json —
#            Vite writes this file only when dep optimisation is fully complete.
#            Before this file exists the page loads HTML but JS bundles are still
#            being compiled; the user sees a black screen until Vite auto-reloads.
#
# Why :5173 not :5180: nginx htpasswd is derived from the NGINX_AUTH_PASS
# provisioning env var while the password file on disk is a fresh random value
# written at runtime — they never match, producing 401 on every attempt.
(
  sleep 15
  START_TIME=\$(date +%s)
  DEADLINE=\$((START_TIME + 720))
  LAST_PING=\$START_TIME
  ATTEMPT=0
  EXIT_CODE=1
  DEPS_META="/opt/bolt-diy/node_modules/.vite/deps/_metadata.json"
  # Remove any stale _metadata.json from a previous session on this machine.
  # Without this, Phase 2 would be skipped on warm machines (file already exists)
  # even though Vite is re-running dep optimisation — causing a black screen.
  rm -f "\$DEPS_META"
  echo "[nim-gate] Phase 1: polling Vite :5173 (deadline 720s)..." >> /var/log/onstart.log
  # Phase 1 — wait for Vite to respond at all
  while [ \$(date +%s) -lt \$DEADLINE ]; do
    ATTEMPT=\$((ATTEMPT + 1))
    NOW=\$(date +%s)
    ELAPSED=\$((NOW - START_TIME + 15))
    HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 \\
      "http://localhost:5173/" 2>/dev/null)
    CURL_EXIT=\$?
    echo "[nim-gate] Attempt \${ATTEMPT} (\${ELAPSED}s): http=\${HTTP_CODE} exit=\${CURL_EXIT}" >> /var/log/onstart.log
    if [ "\$HTTP_CODE" = "200" ] || [ "\$HTTP_CODE" = "302" ]; then
      EXIT_CODE=0
      break
    fi
    if [ \$((NOW - LAST_PING)) -ge 60 ]; then
      LAST_PING=\$NOW
      curl -sf -X POST "\${MIZI_CALLBACK_URL}" \\
        -H "Authorization: Bearer \${MIZI_MEM_AUTH_TOKEN}" \\
        -H "Content-Type: application/json" \\
        -d "{\\"status\\":\\"starting_llm\\",\\"message\\":\\"Bolt.diy starting... (\${ELAPSED}s elapsed)\\"}" \\
        --max-time 10 >> /var/log/onstart.log 2>&1 || true
    fi
    sleep 5
  done
  # Phase 2 — wait for dep optimisation to complete (metadata.json is written
  # by Vite at the very end of esbuild dep bundling; before it exists the browser
  # gets the HTML shell but JS bundles are still compiling → black screen)
  if [ \$EXIT_CODE -eq 0 ] && [ ! -f "\$DEPS_META" ]; then
    echo "[nim-gate] Phase 2: waiting for dep optimisation (_metadata.json)..." >> /var/log/onstart.log
    while [ ! -f "\$DEPS_META" ] && [ \$(date +%s) -lt \$DEADLINE ]; do
      NOW=\$(date +%s)
      ELAPSED=\$((NOW - START_TIME + 15))
      if [ \$((NOW - LAST_PING)) -ge 60 ]; then
        LAST_PING=\$NOW
        echo "[nim-gate] Still compiling JS deps (\${ELAPSED}s)..." >> /var/log/onstart.log
        curl -sf -X POST "\${MIZI_CALLBACK_URL}" \\
          -H "Authorization: Bearer \${MIZI_MEM_AUTH_TOKEN}" \\
          -H "Content-Type: application/json" \\
          -d "{\\"status\\":\\"starting_llm\\",\\"message\\":\\"Bolt.diy bundling JS deps... (\${ELAPSED}s)\\"}" \\
          --max-time 10 >> /var/log/onstart.log 2>&1 || true
      fi
      sleep 5
    done
    if [ -f "\$DEPS_META" ]; then
      echo "[nim-gate] Dep optimisation complete (_metadata.json found)" >> /var/log/onstart.log
    else
      echo "[nim-gate] Deadline reached before dep optimisation finished — opening anyway" >> /var/log/onstart.log
    fi
  fi
  ELAPSED=\$(( \$(date +%s) - START_TIME + 15 ))
  touch /tmp/nim-bolt-ready
  echo "[nim-gate] Gate done: exit=\${EXIT_CODE} elapsed=\${ELAPSED}s attempts=\${ATTEMPT}" >> /var/log/onstart.log
  # Route through the API server's per-session workspace proxy so that each
  # concurrent session has a unique URL that routes to its own machine via
  # Fly.io private networking (6PN). This avoids the shared-app-hostname
  # load-balancer ambiguity where FLY_APP_NAME.fly.dev:5180 could land on
  # any machine in the pool.
  BOLT_URL="${profileConfig.callbackBaseUrl}/api/sessions/${profileConfig.sessionId}/workspace"
  if [ \$EXIT_CODE -eq 0 ]; then
    curl -sf -X POST "\${MIZI_CALLBACK_URL}" \\
      -H "Authorization: Bearer \${MIZI_MEM_AUTH_TOKEN}" \\
      -H "Content-Type: application/json" \\
      -d "{\\"status\\":\\"bolt_ready\\",\\"message\\":\\"Bolt.diy ready (\${ELAPSED}s) — open your coding environment!\\",\\"boltUrl\\":\\"\${BOLT_URL}\\"}" \\
      --max-time 10 >> /var/log/onstart.log 2>&1 || true
  else
    curl -sf -X POST "\${MIZI_CALLBACK_URL}" \\
      -H "Authorization: Bearer \${MIZI_MEM_AUTH_TOKEN}" \\
      -H "Content-Type: application/json" \\
      -d "{\\"status\\":\\"bolt_ready\\",\\"message\\":\\"Bolt.diy warmup timed out — opening anyway (may take a moment to load)\\",\\"boltUrl\\":\\"\${BOLT_URL}\\"}" \\
      --max-time 10 >> /var/log/onstart.log 2>&1 || true
  fi
) &`
    : "";

  // NIM-session watchdog: if the bolt.diy gate never fires bolt_ready within
  // 8 minutes (e.g. gate process crashed), force-send bolt_ready so the user
  // is never stuck on the boot screen forever.  Harmless if gate already fired.
  const nimWatchdogLines = profileConfig.nimModelId && profileConfig.callbackBaseUrl && profileConfig.sessionId != null
    ? `# NIM watchdog: force bolt_ready after 15 min if the gate never fired
(
  sleep 900
  if [ ! -f "/tmp/nim-bolt-ready" ]; then
    echo "[nim-watchdog] Gate never fired — force bolt_ready after 15 min" >> /var/log/onstart.log
    touch /tmp/nim-bolt-ready
    curl -sf -X POST "${profileConfig.callbackBaseUrl}/api/sessions/${profileConfig.sessionId}/status" \\
      -H "Authorization: Bearer ${profileConfig.memAuthToken || ""}" \\
      -H "Content-Type: application/json" \\
      -d "{\\"status\\":\\"bolt_ready\\",\\"message\\":\\"NIM watchdog: force-marking ready after 15 min\\",\\"boltUrl\\":\\"${profileConfig.callbackBaseUrl}/api/sessions/${profileConfig.sessionId}/workspace\\"}" \\
      --max-time 10 >> /var/log/onstart.log 2>&1 || true
  fi
) &`
    : "";

  // Vite HMR fix for Fly.io reverse-proxy — runs inline, before /opt/onstart.sh.
  //
  // Why this is needed:
  //   Users open bolt.diy at https://<app>.fly.dev:5180 (Fly TLS → nginx → Vite:5173).
  //   Vite's HMR client is injected into every HTML page it serves and, by default,
  //   tries to open a WebSocket back to the same host:port the page was loaded from.
  //   If the page was served via the nginx reverse proxy at :5180, the HMR client
  //   will try wss://<host>:5180 — which nginx can then forward to Vite's internal
  //   WS port (:5173).  This works IF nginx has the WS upgrade headers (which
  //   onstart.sh already sets) AND if Vite is told that the *client-side* port is
  //   5180 (not 5173, which Vite assumes by default in some configs).
  //
  //   Setting `server.hmr.clientPort = 5180` in vite.config.ts explicitly tells
  //   Vite: "emit HMR client code that connects to port 5180" — so the injected
  //   script always targets the correct public nginx port regardless of Vite's
  //   internal server port.
  //
  //   NOTE: NGINX_AUTH_USER/NGINX_AUTH_PASS and WebSocket proxy headers are already
  //   handled correctly by onstart.sh in the Docker image.
  //
  //   PER-MACHINE ROUTING NOTE: boltUrl now points to
  //   <callbackBaseUrl>/api/sessions/<id>/workspace — the API server's workspace
  //   proxy route — rather than the shared FLY_APP_NAME.fly.dev:5180 hostname.
  //   The proxy resolves the session's flyMachineId from the DB and forwards all
  //   HTTP traffic to that machine via Fly.io private networking (6PN):
  //   http://<machineId>.vm.<workspaceApp>.internal:5180. This ensures each
  //   concurrent session has a unique, stable URL that routes exclusively to its
  //   own machine regardless of load-balancer decisions.
  const nimViteHmrPatchLines = profileConfig.nimModelId
    ? `# ── Vite HMR clientPort fix (inline, runs before onstart.sh starts Vite) ──
# Tells Vite's HMR client to connect to the public nginx proxy port (5180)
# rather than Vite's internal port (5173), so WebSocket upgrades are routed
# correctly through Fly's TLS terminator and nginx reverse proxy.
BOLT_CONF="/opt/bolt-diy/vite.config.ts"
[ -f "\$BOLT_CONF" ] || BOLT_CONF="/opt/bolt-diy/vite.config.js"
if [ -f "\$BOLT_CONF" ] && ! grep -q "clientPort" "\$BOLT_CONF"; then
  sed -i "s|server: {|server: { hmr: { protocol: 'wss', clientPort: 5180 },|" "\$BOLT_CONF" \\
    && echo "[vite-hmr] Patched \$BOLT_CONF: hmr.clientPort=5180" >> /var/log/onstart.log \\
    || echo "[vite-hmr] Failed to patch \$BOLT_CONF (continuing)" >> /var/log/onstart.log
fi`
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
${bridgeLines}
${teamLine}
${skillsLine}
${githubLines}
${nimBoltWarmupLines}
${nimWatchdogLines}
${nimViteHmrPatchLines}
/opt/onstart.sh
`;
}

// ─── URL builder ─────────────────────────────────────────────────────────────

/**
 * Generate the shell command that injects env vars into a Vast.ai workspace
 * session. Writes to both /workspace/.env.test (workspace convention) and
 * /etc/environment (system-wide, survives new shell spawns).
 *
 * The command is intended to be sent over the Claw Bridge as a "shell" message.
 * Vast.ai sessions communicate exclusively via the Claw Bridge; there is no
 * server-side SSH client in this service.
 */
export function buildEnvInjectionCmd(vars: Record<string, string>): string {
  const lines = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const escaped = lines.replace(/'/g, "'\\''");
  return (
    `mkdir -p /workspace/.mizi && ` +
    `printf '${escaped}\\n' >> /workspace/.env.test && ` +
    `printf '${escaped}\\n' >> /etc/environment`
  );
}

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
