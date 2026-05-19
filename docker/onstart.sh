#!/bin/bash
set -e

LOG_FILE="/var/log/onstart.log"
STATUS_FILE="/tmp/instance-status"
# Tracks whether a failure has already been reported to the dashboard so the
# top-level ERR trap doesn't double-report when a phase has already classified
# its own structured cause (e.g. vllm_warmup_failed, download_failed).
FAILURE_REPORTED_FILE="/tmp/instance-failure-reported"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

set_status() {
    echo "$1" > "$STATUS_FILE"
    log "STATUS: $1"
}

# Report phase to the MIZI dashboard API so the boot log updates in real time.
# MIZI_CALLBACK_URL and MIZI_MEM_AUTH_TOKEN are injected by the API server
# into the onstart environment. Safe no-op if not set.
report_status() {
    local _phase="$1"
    local _msg="$2"
    local _bolt_url="$3"
    if [ -z "${MIZI_CALLBACK_URL:-}" ]; then
        return 0
    fi
    local _payload
    if [ -n "$_bolt_url" ] && [ -n "$_msg" ]; then
        _payload="{\"status\":\"${_phase}\",\"message\":\"${_msg}\",\"boltUrl\":\"${_bolt_url}\"}"
    elif [ -n "$_bolt_url" ]; then
        _payload="{\"status\":\"${_phase}\",\"boltUrl\":\"${_bolt_url}\"}"
    elif [ -n "$_msg" ]; then
        _payload="{\"status\":\"${_phase}\",\"message\":\"${_msg}\"}"
    else
        _payload="{\"status\":\"${_phase}\"}"
    fi
    curl -sf -X POST "${MIZI_CALLBACK_URL}" \
        -H "Authorization: Bearer ${MIZI_MEM_AUTH_TOKEN:-}" \
        -H "Content-Type: application/json" \
        -d "$_payload" \
        --max-time 10 \
        >> "$LOG_FILE" 2>&1 || log "WARNING: status callback failed (phase: $_phase) — dashboard may lag"
}

# Report a structured boot failure to the dashboard. Sets the sentinel file
# so the global ERR trap doesn't overwrite the more specific cause.
# Usage: report_failure "<cause>" "<human message>"
# Causes recognised by the API server (sessions.ts FAILURE_STATUS_MAP):
#   provisioning_failed, download_failed, download_stalled,
#   vllm_warmup_failed, skills_compile_failed, disk_full
report_failure() {
    local _cause="$1"
    local _msg="$2"
    log "BOOT FAILURE: ${_cause} — ${_msg}"
    echo "$_cause" > "$STATUS_FILE"
    touch "$FAILURE_REPORTED_FILE"
    report_status "$_cause" "$_msg"
}

# Detect whether the host filesystem ran out of disk while we were running.
# Looks for "no space left" sentinel in onstart log AND checks `df` for any
# mount under our writable paths that has 0 free space.
detect_disk_full() {
    if grep -qi "no space left on device" "$LOG_FILE" 2>/dev/null; then
        return 0
    fi
    # awk note: a bare `exit 0` in a body block still runs END, and an
    # `END { exit 1 }` would clobber that 0 — making this function always
    # return false. We instead set a flag and exit from END based on it.
    # df -P column 4 = available 1K blocks; treat <= 1MB as "full".
    if df -P /workspace /var/log /tmp 2>/dev/null \
        | awk 'NR>1 && $4+0 <= 1024 { full=1 } END { exit (full ? 0 : 1) }'; then
        return 0
    fi
    return 1
}

# Top-level error trap: on any uncaught failure during Phase 1 (the foreground
# section of this script), report a structured failure to the dashboard so the
# cockpit can show a clear cause + suggested step instead of a generic "error".
# Phase 2 runs in a backgrounded subshell with its own report_failure calls.
on_error() {
    local _exit=$?
    if [ -f "$FAILURE_REPORTED_FILE" ]; then
        # A more specific phase already reported. Preserve its cause.
        exit "$_exit"
    fi
    if detect_disk_full; then
        report_failure "disk_full" "Host disk full during boot — destroy this session and retry on a different host"
    else
        report_failure "provisioning_failed" "Container provisioning failed (exit ${_exit}) — see boot log for details"
    fi
    exit "$_exit"
}
trap on_error ERR

retry() {
    local max_attempts="${RETRY_MAX:-3}"
    local delay="${RETRY_DELAY:-5}"
    local attempt=1
    local cmd="$@"

    while [ $attempt -le $max_attempts ]; do
        if eval "$cmd"; then
            return 0
        fi
        log "Attempt $attempt/$max_attempts failed for: $cmd"
        attempt=$((attempt + 1))
        sleep $delay
    done
    log "All $max_attempts attempts failed for: $cmd"
    return 1
}

MODEL_REPO="${MODEL_REPO:-unsloth/Kimi-K2.6-GGUF}"
MODEL_QUANT="${MODEL_QUANT:-kimi-k2.6}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-kimi-k2-6}"
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-32768}"
VLLM_MAX_NUM_SEQS="${VLLM_MAX_NUM_SEQS:-256}"
VLLM_EXTRA_ARGS="${VLLM_EXTRA_ARGS:-}"
NUM_GPUS="${NUM_GPUS:-1}"
MODEL_BASE_PATH="${MODEL_BASE_PATH:-/workspace/models}"
# Maximum concurrent swarm workers for this instance, sourced from the profile's
# swarmWorkerCap field. Exported so the Claw Runner can enforce it without
# needing to know which model is running. 0 = no cap / swarm not configured.
SWARM_MAX_WORKERS="${SWARM_MAX_WORKERS:-0}"
export SWARM_MAX_WORKERS

# VLLM_PORT is the external port (litellm proxy — speaks OpenAI + Anthropic API)
VLLM_PORT="${VLLM_PORT:-8081}"
# Internal port for vLLM (OpenAI format only)
VLLM_INTERNAL_PORT=8082
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"
BOLT_PORT="${BOLT_PORT:-5173}"
PREVIEW_PORT="${PREVIEW_PORT:-3000}"

if [ -z "$CODE_SERVER_PASSWORD" ]; then
    CODE_SERVER_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
    echo "$CODE_SERVER_PASSWORD" > /workspace/.code-server-password
    chmod 600 /workspace/.code-server-password
    log "code-server password generated and stored at /workspace/.code-server-password (readable after SSH)"
fi

# TEAM_MEMBERS_JSON is optional: JSON array of {name, password, path} objects.
# First element is always __shared__ when present.
# e.g. '[{"name":"__shared__","password":"...","path":"/shared/"},{"name":"alice","password":"...","path":"/ide/alice/"}]'
TEAM_MEMBERS_JSON="${TEAM_MEMBERS_JSON:-}"
# Internal ports for team member code-server instances (not exposed externally)
TEAM_MEMBER_INTERNAL_PORTS=(8093 8094 8095 8096)
SHARED_INTERNAL_PORT=8097

log "=== MIZI Coding Environment Starting ==="
log "Model: $MODEL_REPO (cached as $MODEL_QUANT)"
log "GPUs: $NUM_GPUS | vLLM max-model-len: $VLLM_MAX_MODEL_LEN | max-num-seqs: $VLLM_MAX_NUM_SEQS"

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1: Start all services immediately (no model needed)
# ─────────────────────────────────────────────────────────────────────────────
set_status "starting"

log "Starting SSH server with key-based auth only..."
mkdir -p /root/.ssh
chmod 700 /root/.ssh
ssh-keygen -A
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
echo "PermitRootLogin prohibit-password" >> /etc/ssh/sshd_config
/usr/sbin/sshd
log "SSH server started (key-based auth only)"

# For team sessions, owner's code-server moves to an internal port (nginx will own port 8080).
# For solo sessions, code-server binds directly on 8080 (existing behaviour).
if [ -n "$TEAM_MEMBERS_JSON" ]; then
    OWNER_CODE_SERVER_INTERNAL_PORT=8090
    log "Team session: owner code-server will start on internal port $OWNER_CODE_SERVER_INTERNAL_PORT (nginx routes port 8080)"
else
    OWNER_CODE_SERVER_INTERNAL_PORT=$CODE_SERVER_PORT
fi

log "Starting code-server (owner) on port $OWNER_CODE_SERVER_INTERNAL_PORT..."
mkdir -p /workspace/projects
PASSWORD="$CODE_SERVER_PASSWORD" code-server \
    --bind-addr "0.0.0.0:${OWNER_CODE_SERVER_INTERNAL_PORT}" \
    --auth password \
    --disable-telemetry \
    /workspace/projects \
    > /var/log/code-server.log 2>&1 &
log "code-server (owner) started"

log "Starting Claw Task Runner on port 5182..."
# Wire swarm worker cap from profile env (swarmWorkerCap → SWARM_MAX_WORKERS).
# Profile sets swarmWorkerCap; if absent, fall back to any pre-existing
# SWARM_MAX_WORKERS, then default to 4.
SWARM_MAX_WORKERS="${SWARM_MAX_WORKERS:-${swarmWorkerCap:-4}}"
export SWARM_MAX_WORKERS
log "Swarm orchestration: SWARM_MAX_WORKERS=${SWARM_MAX_WORKERS} (source: swarmWorkerCap=${swarmWorkerCap:-unset})"
node /opt/claw-runner.js > /var/log/claw-runner.log 2>&1 &
log "Claw Task Runner started"

# ─────────────────────────────────────────────────────────────────────────────
# Claw Bridge: outbound WebSocket connection to the MIZI API server
# Allows external agents to send prompts to this lane and stream responses.
# MIZI_BRIDGE_URL is set by the API server when launching the instance and
# follows the pattern: wss://<api-host>/api/bridge/:sessionId/:laneId
# MIZI_LANE_ID selects which lane this process is connected to (default: 0
# for the primary/owner lane).
# The bridge process handles reconnection with backoff, so we start it once.
# ─────────────────────────────────────────────────────────────────────────────
if [ -n "${MIZI_BRIDGE_URL:-}" ] && [ -f "/opt/claw-bridge.mjs" ]; then
    log "Starting Claw Bridge (session=${MIZI_SESSION_ID:-?} lane=${MIZI_LANE_ID:-0})..."
    MIZI_LANE_ID="${MIZI_LANE_ID:-0}" \
    BRIDGE_LOG_FILE="/var/log/claw-bridge.log" \
    node /opt/claw-bridge.mjs >> /var/log/claw-bridge.log 2>&1 &
    BRIDGE_PID=$!
    log "Claw Bridge started (PID ${BRIDGE_PID}) — connecting to ${MIZI_BRIDGE_URL}"
else
    log "Claw Bridge: MIZI_BRIDGE_URL not set or claw-bridge.mjs not installed — bridge skipped"
fi

log "Configuring Bolt.diy..."
cd /opt/bolt-diy
cat > .env.local << EOF
OPENAI_LIKE_API_BASE_URL=http://localhost:${VLLM_PORT}/v1
OPENAI_LIKE_API_KEY=not-needed
DEFAULT_NUM_CTX=${VLLM_MAX_MODEL_LEN}
EOF

log "Starting Bolt.diy on port $BOLT_PORT..."
PORT=$BOLT_PORT pnpm run dev > /var/log/bolt-diy.log 2>&1 &
log "Bolt.diy started"

log "Configuring nginx with basic auth for exposed services..."
NGINX_AUTH_USER="${NGINX_AUTH_USER:-mizi}"
NGINX_AUTH_PASS="${NGINX_AUTH_PASS:-$CODE_SERVER_PASSWORD}"
htpasswd -cb /etc/nginx/.htpasswd "$NGINX_AUTH_USER" "$NGINX_AUTH_PASS" 2>/dev/null
log "Nginx credentials — user: $NGINX_AUTH_USER, pass: in /workspace/.code-server-password"

cat > /etc/nginx/sites-available/preview << 'NGINX'
server {
    listen 3000;
    server_name _;
    auth_basic "MIZI Preview";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://localhost:5174;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}

server {
    listen 5180;
    server_name _;
    auth_basic "MIZI Bolt.diy";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}

server {
    listen 5181;
    server_name _;
    auth_basic "MIZI Claw Runner";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://localhost:5182;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/preview /etc/nginx/sites-enabled/preview
rm -f /etc/nginx/sites-enabled/default

nginx -t && nginx
log "nginx started — ports 5180 (Bolt), 5181 (Claw Runner), 3000 (Preview) open"

# ─────────────────────────────────────────────────────────────────────────────
# Team session: path-based nginx routing on port 8080
# Owner IDE: /            → internal 8090
# Member IDEs: /ide/<name>/ → internal 8093-8096
# Shared workspace: /shared/ → internal 8097  (combined htpasswd: all members)
# All traffic flows through the single exposed port 8080.
# ─────────────────────────────────────────────────────────────────────────────
if [ -n "$TEAM_MEMBERS_JSON" ]; then
    log "Team session: configuring path-based nginx routing on port 8080..."

    # Validate JSON is parseable
    if ! echo "$TEAM_MEMBERS_JSON" | jq -e '.' > /dev/null 2>&1; then
        log "ERROR: TEAM_MEMBERS_JSON is not valid JSON — skipping team setup"
    else

    # Open the server block (owner's code-server at /)
    cat > /etc/nginx/sites-available/team-ide << 'TEAM_NGINX_OPEN'
server {
    listen 8080;
    server_name _;

    # Owner IDE at /
    location / {
        auth_basic "MIZI";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://localhost:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
TEAM_NGINX_OPEN

    # ── Combine all team member credentials into a shared htpasswd file ──
    _SHARED_HTPASSWD=/etc/nginx/.htpasswd-shared
    cp /dev/null "$_SHARED_HTPASSWD"

    _tm_named_idx=0

    while IFS= read -r _TM_ENTRY_JSON; do
        _TM_NAME=$(printf '%s' "$_TM_ENTRY_JSON" | jq -r '.name')
        _TM_PASS=$(printf '%s' "$_TM_ENTRY_JSON" | jq -r '.password')
        _TM_PATH=$(printf '%s' "$_TM_ENTRY_JSON" | jq -r '.path')

        if [ "$_TM_NAME" = "__shared__" ]; then
            # Shared workspace: nginx handles all auth via combined htpasswd.
            # code-server runs with --auth none (nginx is the sole auth gate).
            _TM_INT_PORT=$SHARED_INTERNAL_PORT
            _TM_WORKSPACE=/workspace/shared
        else
            if [ $_tm_named_idx -ge 4 ]; then
                log "Skipping '$_TM_NAME' — max 4 named members reached"
                continue
            fi
            _TM_INT_PORT="${TEAM_MEMBER_INTERNAL_PORTS[$_tm_named_idx]}"
            _TM_WORKSPACE="/workspace/users/${_TM_NAME}"
            _tm_named_idx=$((_tm_named_idx + 1))

            # Per-member htpasswd (for /ide/<name>/ location)
            htpasswd -cb "/etc/nginx/.htpasswd-${_TM_NAME}" "$_TM_NAME" "$_TM_PASS" 2>/dev/null

            # Add member credential to the shared htpasswd (all members can access /shared/)
            htpasswd -b "$_SHARED_HTPASSWD" "$_TM_NAME" "$_TM_PASS" 2>/dev/null
        fi

        mkdir -p "$_TM_WORKSPACE"

        # Write ANTHROPIC_BASE_URL .env so claw-code uses the litellm proxy inside the container
        cat > "${_TM_WORKSPACE}/.env" << MEMBER_ENV
ANTHROPIC_BASE_URL=http://localhost:8081
ANTHROPIC_API_KEY=not-needed
MEMBER_ENV
        chmod 600 "${_TM_WORKSPACE}/.env"

        if [ "$_TM_NAME" = "__shared__" ]; then
            # Shared code-server: nginx is the sole auth gate (combined htpasswd).
            # Run without code-server password so member creds work transparently.
            code-server \
                --bind-addr "0.0.0.0:${_TM_INT_PORT}" \
                --auth none \
                --disable-telemetry \
                --base-path "${_TM_PATH}" \
                "$_TM_WORKSPACE" \
                > "/var/log/code-server-${_TM_NAME}.log" 2>&1 &
        else
            PASSWORD="$_TM_PASS" code-server \
                --bind-addr "0.0.0.0:${_TM_INT_PORT}" \
                --auth password \
                --disable-telemetry \
                --base-path "${_TM_PATH}" \
                "$_TM_WORKSPACE" \
                > "/var/log/code-server-${_TM_NAME}.log" 2>&1 &
        fi

        if [ "$_TM_NAME" = "__shared__" ]; then
            # /shared/ uses the combined htpasswd (populated after all named members are processed)
            printf '    location /shared/ {\n        auth_basic "MIZI Shared";\n        auth_basic_user_file %s;\n        proxy_pass http://localhost:%s;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_read_timeout 86400;\n    }\n' \
                "$_SHARED_HTPASSWD" "$_TM_INT_PORT" \
                >> /etc/nginx/sites-available/team-ide
        else
            printf '    location %s {\n        auth_basic "MIZI - %s";\n        auth_basic_user_file /etc/nginx/.htpasswd-%s;\n        proxy_pass http://localhost:%s;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_read_timeout 86400;\n    }\n' \
                "$_TM_PATH" "$_TM_NAME" "$_TM_NAME" "$_TM_INT_PORT" \
                >> /etc/nginx/sites-available/team-ide
        fi

        log "Team member '$_TM_NAME': code-server port=$_TM_INT_PORT path=$_TM_PATH workspace=$_TM_WORKSPACE"
    done < <(printf '%s' "$TEAM_MEMBERS_JSON" | jq -c '.[]')

    # Close the server block
    echo '}' >> /etc/nginx/sites-available/team-ide

    ln -sf /etc/nginx/sites-available/team-ide /etc/nginx/sites-enabled/team-ide
    nginx -t && nginx -s reload
    log "nginx reloaded with team path-based routing on port 8080"

    fi  # end TEAM_MEMBERS_JSON valid JSON guard
fi

# Mark phase 1 done — code-server, Bolt.diy, and nginx are up.
# Use "services_ready" (not "ready") so the dashboard knows tools are accessible
# but does NOT yet confuse this with full LLM readiness. "ready" is reserved for
# the final "llm_ready" state set by Phase 2 once vLLM is online.
set_status "services_ready"
report_status "services_ready"
touch /tmp/instance-ready
log "=== Phase 1 done — code-server and tools available (LLM loading in background) ==="

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1.5: Smart Skills bundle activation
# Runs synchronously after services_ready, before model download begins.
# MIZI_ACTIVE_BUNDLE_B64 is a base64-encoded JSON payload containing:
#   - bundleSlug, tokenMode, skills[], systemPromptFragment
# ─────────────────────────────────────────────────────────────────────────────
if [ -n "${MIZI_ACTIVE_BUNDLE_B64:-}" ]; then
    log "=== Phase 1.5: Smart Skills bundle activation ==="
    set_status "skills_compiling"
    report_status "skills_compiling" "Activating Smart Skills bundle..."

    MIZI_DIR="/workspace/.mizi"
    SKILLS_DIR="$MIZI_DIR/skills"
    PROMPTS_DIR="/workspace/.mizi/prompts"
    mkdir -p "$SKILLS_DIR" "$PROMPTS_DIR"

    SKILL_PROMPTS_DIR="$PROMPTS_DIR/skills"
    mkdir -p "$SKILL_PROMPTS_DIR"

    # Decode and write the bundle JSON
    if printf '%s' "$MIZI_ACTIVE_BUNDLE_B64" | base64 -d > "$SKILLS_DIR/active-bundle.json" 2>/dev/null; then
        log "Smart Skills: active-bundle.json written to $SKILLS_DIR"

        if command -v jq > /dev/null 2>&1; then
            BUNDLE_SLUG=$(jq -r '.bundleSlug // "unknown"' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
            TOKEN_MODE=$(jq -r '.tokenMode // "core"' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
            SKILL_COUNT=$(jq '.skills | length' "$SKILLS_DIR/active-bundle.json" 2>/dev/null || echo "0")
            log "Smart Skills: bundle=$BUNDLE_SLUG tokenMode=$TOKEN_MODE skillCount=$SKILL_COUNT"

            # Write token-mode.json to mizi root (not skills/) for runtime layer inspection
            printf '{"tokenMode":"%s","bundleSlug":"%s","skillCount":%s,"activatedAt":"%s"}\n' \
                "$TOKEN_MODE" "$BUNDLE_SLUG" "$SKILL_COUNT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                > "$MIZI_DIR/token-mode.json"
            log "Smart Skills: token-mode.json written to $MIZI_DIR/token-mode.json"

            # Write the combined system prompt fragment
            PROMPT_FRAGMENT=$(jq -r '.systemPromptFragment // empty' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
            if [ -n "$PROMPT_FRAGMENT" ]; then
                printf '%s\n' "$PROMPT_FRAGMENT" > "$PROMPTS_DIR/active-bundle.md"
                log "Smart Skills: prompt fragment written to $PROMPTS_DIR/active-bundle.md"
                echo "MIZI_SKILLS_PROMPT_PATH=$PROMPTS_DIR/active-bundle.md" >> /etc/environment
            fi

            # Write individual per-skill prompt files: prompts/skills/<skill-id>.md
            # Payload stores skills[].instructions as a flat string array (not {system:[...]})
            SKILL_IDS=$(jq -r '.skills[].id' "$SKILLS_DIR/active-bundle.json" 2>/dev/null || true)
            for SKILL_ID in $SKILL_IDS; do
                SKILL_BULLETS=$(jq -r --arg sid "$SKILL_ID" \
                    '.skills[] | select(.id==$sid) | .instructions // [] | if type=="array" then .[] else . end' \
                    "$SKILLS_DIR/active-bundle.json" 2>/dev/null || true)
                if [ -n "$SKILL_BULLETS" ]; then
                    printf '%s\n' "$SKILL_BULLETS" > "$SKILL_PROMPTS_DIR/${SKILL_ID}.md"
                    log "Smart Skills: wrote prompts/skills/${SKILL_ID}.md"
                fi
            done
        fi

        set_status "skills_ready"
        report_status "skills_ready" "Smart Skills bundle loaded"
        log "=== Phase 1.5 done — Smart Skills bundle active ==="
    else
        # Bundle decode failed — report a structured cause so the cockpit can
        # show a clear "Smart Skills compile failed" row rather than letting
        # the session look "starting" forever. Non-fatal: we proceed without
        # skills so the user can still SSH in and inspect.
        report_failure "skills_compile_failed" "Failed to decode MIZI_ACTIVE_BUNDLE_B64 — Smart Skills unavailable this session"
        # Clear the failure sentinel so subsequent phases (download, vLLM)
        # can still report their own status — Phase 1.5 is non-blocking.
        rm -f "$FAILURE_REPORTED_FILE"
    fi
else
    log "No Smart Skills bundle configured for this session — skipping Phase 1.5"
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1.6: Repo Intelligence daemon (async, non-blocking)
# Starts the repo-indexer in daemon (polling) mode if MIZI_SESSION_ID is set.
# The daemon polls for queued indexing jobs and processes them automatically.
# MIZI_REPO_JOB_ID can be pre-set to run a specific job immediately.
# Hard limits: REPO_INDEX_MAX_DURATION_MS (default 300000ms = 5min).
# ─────────────────────────────────────────────────────────────────────────────
REPO_INTEL_DIR="/opt/repo-intelligence"
MIZI_DIR="/workspace/.mizi"
mkdir -p "$MIZI_DIR"

if [ -n "${MIZI_SESSION_ID:-}" ] && [ -f "${REPO_INTEL_DIR}/repo-indexer.mjs" ]; then
    log "=== Phase 1.6: Starting Repo Intelligence daemon (session ${MIZI_SESSION_ID}) ==="
    export MIZI_REPO_PATH="${MIZI_REPO_PATH:-/workspace/projects}"
    export REPO_INDEX_POLL_INTERVAL_SECS="${REPO_INDEX_POLL_INTERVAL_SECS:-30}"
    export REPO_INDEX_MAX_DURATION_MS="${REPO_INDEX_MAX_DURATION_MS:-300000}"

    node "${REPO_INTEL_DIR}/repo-indexer.mjs" \
        >> /var/log/repo-indexer.log 2>&1 &
    REPO_INDEXER_PID=$!
    log "Repo Intelligence: daemon started (PID ${REPO_INDEXER_PID}), polling every ${REPO_INDEX_POLL_INTERVAL_SECS}s"
    log "Repo Intelligence: tail /var/log/repo-indexer.log to monitor progress"
else
    if [ -z "${MIZI_SESSION_ID:-}" ]; then
        log "Repo Intelligence: MIZI_SESSION_ID not set — skipping Phase 1.6"
    else
        log "WARNING: Repo Intelligence scripts not found at ${REPO_INTEL_DIR} — skipping Phase 1.6"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1.7: Context Shield + Working State Continuity provisioning
# Provisions the per-session SQLite event journal, creates the artifacts
# directory, installs mizi_execute CLI wrapper, and runs artifact cleanup.
# Non-blocking: failures are logged but do not abort startup.
# ─────────────────────────────────────────────────────────────────────────────
log "=== Phase 1.7: Context Shield + Working State Continuity ==="

MIZI_DIR="/workspace/.mizi"
ARTIFACTS_DIR="$MIZI_DIR/artifacts"
STATE_DB="$MIZI_DIR/session-state.db"
STATE_SCRIPT="${REPO_INTEL_DIR}/session-state.mjs"
SHIELD_SCRIPT="${REPO_INTEL_DIR}/context-shield.mjs"

mkdir -p "$ARTIFACTS_DIR"
log "Context Shield: artifacts directory ready at $ARTIFACTS_DIR"

# Provision the session-state.db (creates tables if not present)
if [ -f "$STATE_SCRIPT" ]; then
    if node "$STATE_SCRIPT" provision >> "$LOG_FILE" 2>&1; then
        log "Context Shield: session journal provisioned at $STATE_DB"
    else
        log "WARNING: session journal provisioning failed — event capture will be unavailable"
    fi
else
    log "Context Shield: session-state.mjs not found at $STATE_SCRIPT — skipping journal provisioning"
fi

# Install mizi_execute / mizi_execute_file / mizi_batch_execute wrappers
# These are callable by the claw model via its bash tool.
if [ -f "$SHIELD_SCRIPT" ]; then
    cat > /usr/local/bin/mizi_execute << WRAPPER
#!/bin/bash
# mizi_execute — shielded command execution (Context Shield)
# Usage: mizi_execute <command and args...>
exec node "${SHIELD_SCRIPT}" exec "\$@"
WRAPPER
    chmod +x /usr/local/bin/mizi_execute

    cat > /usr/local/bin/mizi_execute_file << WRAPPER
#!/bin/bash
# mizi_execute_file — shielded file read (Context Shield)
# Usage: mizi_execute_file <path>
exec node "${SHIELD_SCRIPT}" exec-file "\$@"
WRAPPER
    chmod +x /usr/local/bin/mizi_execute_file

    cat > /usr/local/bin/mizi_batch_execute << WRAPPER
#!/bin/bash
# mizi_batch_execute — shielded batch execution (Context Shield)
# Usage: mizi_batch_execute '<json commands array>'
exec node "${SHIELD_SCRIPT}" batch "\$@"
WRAPPER
    chmod +x /usr/local/bin/mizi_batch_execute

    cat > /usr/local/bin/mizi_stats << WRAPPER
#!/bin/bash
# mizi_stats — shielded execution statistics
exec node "${SHIELD_SCRIPT}" stats
WRAPPER
    chmod +x /usr/local/bin/mizi_stats

    cat > /usr/local/bin/mizi_doctor << WRAPPER
#!/bin/bash
# mizi_doctor — shield health diagnostics
exec node "${SHIELD_SCRIPT}" doctor
WRAPPER
    chmod +x /usr/local/bin/mizi_doctor

    log "Context Shield: mizi_execute / mizi_execute_file / mizi_batch_execute / mizi_stats / mizi_doctor installed to /usr/local/bin/"

    # Run artifact cleanup in background (remove stale artifacts from prior runs)
    node "$SHIELD_SCRIPT" cleanup >> "$LOG_FILE" 2>&1 &
    log "Context Shield: background artifact cleanup started"
else
    log "Context Shield: context-shield.mjs not found at $SHIELD_SCRIPT — CLI wrappers not installed"
fi

# Write boot event to the journal
if [ -f "$STATE_SCRIPT" ]; then
    _BOOT_EVENT="{\"actor_type\":\"onstart\",\"event_type\":\"session_boot\",\"payload\":{\"sessionId\":\"${MIZI_SESSION_ID:-unknown}\"}}"
    node "$STATE_SCRIPT" append-event "$_BOOT_EVENT" >> "$LOG_FILE" 2>&1 || true
fi

log "=== Phase 1.7 done — Context Shield provisioned ==="

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2: Model download + vLLM + litellm in background
# ─────────────────────────────────────────────────────────────────────────────
log "Starting LLM backend in background..."

(
    # ── NIM fast-boot: hosted-inference mode (skips vLLM and model download) ──
    # When NIM_MODEL_ID is set, the workspace uses a partner-cloud or NVIDIA-hosted
    # LLM API instead of a locally-downloaded model. LiteLLM proxies the API so
    # claw-code still sees the standard Anthropic/OpenAI interface on localhost.
    if [ -n "${NIM_MODEL_ID:-}" ]; then
        log "=== NIM Mode: Using hosted inference (${NIM_MODEL_ID}) via ${NIM_API_BASE} ==="
        echo "starting_llm" > "$STATUS_FILE"
        # Build the bolt.diy public URL so the dashboard can surface the Preview tab.
        # FLY_APP_NAME is injected automatically by Fly.io into every machine in the app.
        # BOLT_PORT is set to 5180 at session creation so it matches the Fly service mapping.
        _BOLT_URL=""
        if [ -n "${FLY_APP_NAME:-}" ]; then
            _BOLT_URL="https://${FLY_APP_NAME}.fly.dev:${BOLT_PORT:-5180}"
        fi
        report_status "starting_llm" "Starting NIM proxy..." "$_BOLT_URL"

        # Write the initial LiteLLM config. The reload script (/opt/mizi/reload-model.sh)
        # rewrites this file and sends SIGHUP when a mid-session model switch is requested.
        # Starting from a config file (not CLI flags) is what makes hot-reloading work:
        # SIGHUP causes litellm to re-read the config from disk, picking up the new model.
        NIM_LITELLM_CONFIG="/opt/mizi/litellm_config.yaml"
        mkdir -p /opt/mizi

        # Build LiteLLM config with dual-model support:
        # - "default"  → orchestrator model (NIM_MODEL_ID) — used by claw-code
        # - "swarm"    → economy model (SWARM_MODEL_ID) — used by swarm workers
        # Having both in the same proxy means workers can call the swarm endpoint
        # independently, preventing contention with the orchestrator's quality model.
        {
          echo "model_list:"
          echo "  - model_name: default"
          echo "    litellm_params:"
          echo "      model: \"openai/${NIM_MODEL_ID}\""
          echo "      api_base: \"${NIM_API_BASE:-https://integrate.api.nvidia.com/v1}\""
          echo "      api_key: \"${NIM_API_KEY:-not-needed}\""
          if [ -n "${SWARM_MODEL_ID:-}" ]; then
            echo "  - model_name: swarm"
            echo "    litellm_params:"
            echo "      model: \"openai/${SWARM_MODEL_ID}\""
            echo "      api_base: \"${SWARM_API_BASE:-${NIM_API_BASE:-https://integrate.api.nvidia.com/v1}}\""
            echo "      api_key: \"${SWARM_API_KEY:-${NIM_API_KEY:-not-needed}}\""
            log "LiteLLM: dual-model config (orchestrator=${NIM_MODEL_ID}, swarm=${SWARM_MODEL_ID})"
          fi
          echo "general_settings:"
          echo "  num_router_workers: 1"
        } > "$NIM_LITELLM_CONFIG"
        log "LiteLLM config written to $NIM_LITELLM_CONFIG"

        log "Starting LiteLLM NIM proxy on port $VLLM_PORT (config-file mode)..."
        litellm \
            --config "$NIM_LITELLM_CONFIG" \
            --host 0.0.0.0 \
            --port "$VLLM_PORT" \
            > /var/log/litellm.log 2>&1 &
        NIM_LITELLM_PID=$!
        log "LiteLLM NIM proxy started (PID: $NIM_LITELLM_PID)"

        # Wait for LiteLLM to come up (should be fast — no model to load).
        _nim_ready=0
        for i in $(seq 1 30); do
            if curl -sf "http://localhost:$VLLM_PORT/health" > /dev/null 2>&1; then
                log "LiteLLM NIM proxy ready on port $VLLM_PORT"
                _nim_ready=1
                break
            fi
            sleep 2
        done

        export ANTHROPIC_BASE_URL="http://localhost:${VLLM_PORT}"
        export ANTHROPIC_API_KEY="not-needed"
        echo "ANTHROPIC_BASE_URL=http://localhost:${VLLM_PORT}" >> /etc/environment
        echo "ANTHROPIC_API_KEY=not-needed" >> /etc/environment
        echo "export ANTHROPIC_BASE_URL=http://localhost:${VLLM_PORT}" >> /root/.bashrc
        echo "export ANTHROPIC_API_KEY=not-needed" >> /root/.bashrc
        log "claw-code configured: ANTHROPIC_BASE_URL -> LiteLLM NIM proxy (port $VLLM_PORT)"

        if [ "$_nim_ready" -eq 1 ]; then
            echo "llm_ready" > "$STATUS_FILE"
            report_status "llm_ready"
        fi
        log "=== NIM Mode: Proxy ready — NIM_MODEL_ID=${NIM_MODEL_ID} ==="
        log "  LLM Proxy:   http://localhost:$VLLM_PORT (OpenAI + Anthropic via litellm → NIM)"
        log "  Upstream:    ${NIM_API_BASE}"
        log "  Config:      $NIM_LITELLM_CONFIG (hot-reload on SIGHUP)"

        # Keep LiteLLM alive with auto-restart.
        # IMPORTANT: restart from the config file, not from original CLI flags —
        # this ensures a post-switch restart picks up the new model/provider written
        # by /opt/mizi/reload-model.sh rather than reverting to the launch-time model.
        while true; do
            if ! kill -0 "$NIM_LITELLM_PID" 2>/dev/null; then
                log "LiteLLM NIM proxy died — restarting from config ($NIM_LITELLM_CONFIG)..."
                litellm \
                    --config "$NIM_LITELLM_CONFIG" \
                    --host 0.0.0.0 \
                    --port "$VLLM_PORT" \
                    >> /var/log/litellm.log 2>&1 &
                NIM_LITELLM_PID=$!
                log "LiteLLM NIM proxy restarted (PID: $NIM_LITELLM_PID)"
            fi
            sleep 30
        done
    fi
    # ── End NIM fast-boot ─────────────────────────────────────────────────────

    MODEL_DIR="$MODEL_BASE_PATH/$MODEL_QUANT"

    if [ -d "$MODEL_DIR" ] && ls "$MODEL_DIR"/*.safetensors > /dev/null 2>&1; then
        log "Model found at $MODEL_DIR — skipping download"
    else
        echo "downloading" > "$STATUS_FILE"
        report_status "downloading"
        log "Downloading model $MODEL_REPO to $MODEL_DIR — this may take a while..."
        mkdir -p "$MODEL_DIR"
        # Phase 2 runs inside a backgrounded subshell, so the top-level ERR
        # trap does NOT fire here. We must classify download failures inline
        # and exit the subshell so the runaway `wait` on the parent stays
        # alive (other services keep serving) while the dashboard sees a
        # clear cause.
        #
        # Three failure modes get distinct causes so the dashboard can
        # surface different next-step guidance:
        #   - disk_full         → destroy + retry on different host
        #   - download_stalled  → network/HF unreachable; retry or change region
        #   - download_failed   → generic retry exhaustion (other errors)
        #
        # Stall detection: run the download in the background and poll the
        # on-disk size of MODEL_DIR. If size does not grow for
        # DOWNLOAD_STALL_TIMEOUT_SEC (default 180s) of consecutive checks,
        # kill the download tree and report download_stalled. This catches
        # "TCP connected but no bytes flowing" cases that retry alone won't.
        DOWNLOAD_STALL_TIMEOUT_SEC="${DOWNLOAD_STALL_TIMEOUT_SEC:-180}"
        DOWNLOAD_STALL_POLL_SEC="${DOWNLOAD_STALL_POLL_SEC:-15}"

        _measure_dir_bytes() {
            du -sb "$1" 2>/dev/null | awk '{print $1+0}' || echo 0
        }

        # Launch download in background; capture pid for the watchdog.
        retry huggingface-cli download "$MODEL_REPO" \
            --local-dir "$MODEL_DIR" \
            --local-dir-use-symlinks False \
            --resume-download &
        _DL_PID=$!

        _last_size=$(_measure_dir_bytes "$MODEL_DIR")
        _stall_elapsed=0
        _stalled=0
        while kill -0 "$_DL_PID" 2>/dev/null; do
            sleep "$DOWNLOAD_STALL_POLL_SEC"
            _now_size=$(_measure_dir_bytes "$MODEL_DIR")
            if [ "$_now_size" -gt "$_last_size" ]; then
                _last_size=$_now_size
                _stall_elapsed=0
            else
                _stall_elapsed=$((_stall_elapsed + DOWNLOAD_STALL_POLL_SEC))
                log "Download progress check: no new bytes for ${_stall_elapsed}s (limit ${DOWNLOAD_STALL_TIMEOUT_SEC}s)"
                if [ "$_stall_elapsed" -ge "$DOWNLOAD_STALL_TIMEOUT_SEC" ]; then
                    _stalled=1
                    log "Download stalled — killing pid $_DL_PID and child processes"
                    pkill -P "$_DL_PID" 2>/dev/null || true
                    kill -TERM "$_DL_PID" 2>/dev/null || true
                    sleep 2
                    kill -KILL "$_DL_PID" 2>/dev/null || true
                    break
                fi
            fi
        done

        wait "$_DL_PID" 2>/dev/null
        _DL_RC=$?

        if [ "$_stalled" -eq 1 ]; then
            report_failure "download_stalled" "Model download stalled — no new bytes written for ${DOWNLOAD_STALL_TIMEOUT_SEC}s. HuggingFace or host network is unreachable; destroy and retry, ideally in a different region."
            exit 1
        fi

        if [ "$_DL_RC" -ne 0 ]; then
            if detect_disk_full; then
                report_failure "disk_full" "Model download failed — host disk full. Destroy and retry on a different host."
            else
                report_failure "download_failed" "Model weight download from HuggingFace failed after $((${RETRY_MAX:-3})) attempts"
            fi
            exit 1
        fi
        log "Model download complete"
    fi

    echo "starting_llm" > "$STATUS_FILE"
    report_status "starting_llm"
    log "Starting vLLM server on internal port $VLLM_INTERNAL_PORT..."

    # ── vLLM capability-based flag gating ────────────────────────────────────
    # We probe the installed vLLM's --help output to determine which flags are
    # actually present in this build. This is more reliable than version-number
    # comparisons because it catches flags removed or renamed in patch builds
    # and avoids boot failures regardless of the exact vLLM wheel installed.
    VLLM_VERSION=$(python3 -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "unknown")
    log "Detected vLLM version: $VLLM_VERSION"

    # Capture help text (vLLM may write to stdout or stderr; capture both).
    # Suppress errors: if the module fails to import, _VLLM_HELP is empty and
    # all flags are treated as unsupported — safe conservative fallback.
    _VLLM_HELP=$(python3 -m vllm.entrypoints.openai.api_server --help 2>&1 || true)

    # Returns 0 (true) if the flag name appears in the help output.
    _vllm_has_flag() {
        echo "$_VLLM_HELP" | grep -q -- "$1"
    }

    # Strip a flag (and its value, if any) from VLLM_EXTRA_ARGS.
    # Handles both "--flag value" and standalone "--flag" forms.
    # Uses python3 shlex for reliable tokenisation — always present in the image.
    _strip_vllm_flag() {
        local _f="$1"
        if echo "$VLLM_EXTRA_ARGS" | grep -q -- "$_f"; then
            VLLM_EXTRA_ARGS=$(python3 -c "
import sys, shlex
args_str, flag = sys.argv[1], sys.argv[2]
tokens = shlex.split(args_str) if args_str.strip() else []
result = []
i = 0
while i < len(tokens):
    if tokens[i] == flag:
        # Skip this flag and its value token (if any and not another flag)
        if i + 1 < len(tokens) and not tokens[i + 1].startswith('-'):
            i += 2
        else:
            i += 1
    else:
        result.append(tokens[i])
        i += 1
print(shlex.join(result))
" "$VLLM_EXTRA_ARGS" "$_f" 2>/dev/null || echo "$VLLM_EXTRA_ARGS")
            log "  Removed $_f from VLLM_EXTRA_ARGS (not present in this vLLM build)"
        fi
    }

    # ── Per-flag capability gating for VLLM_EXTRA_ARGS ───────────────────────
    # All flags below were added to llamaExtraArgs profiles in this task.
    # Strip any flag that is not recognised by the installed vLLM, regardless of
    # version. This prevents boot failures on any past or future build.
    #
    # --enable-chunked-prefill: if absent, strip the entire chunked-prefill group
    #   since the companion knobs are meaningless without it.
    # --scheduling-policy: requires priority scheduling support.
    # --max-num-partial-prefills / --max-long-partial-prefills / --long-prefill-token-threshold:
    #   vLLM 0.19.0+ partial-prefill tuning.
    _SWARM_FLAGS=(
        "--enable-chunked-prefill"
        "--max-num-batched-tokens"
        "--max-num-partial-prefills"
        "--max-long-partial-prefills"
        "--long-prefill-token-threshold"
        "--scheduling-policy"
    )
    _stripped_any=0
    for _flag in "${_SWARM_FLAGS[@]}"; do
        if ! _vllm_has_flag "$_flag"; then
            _strip_vllm_flag "$_flag"
            _stripped_any=1
        fi
    done
    if [ "$_stripped_any" -eq 1 ]; then
        log "VLLM_EXTRA_ARGS after capability stripping: $VLLM_EXTRA_ARGS"
    fi

    # ── Per-flag capability gating for command-level swarm flags ─────────────
    # --disable-log-requests: suppresses per-request log lines; safe for all profiles.
    # --uvicorn-log-level warning: reduces uvicorn INFO noise in swarm workloads.
    # Both are added only when confirmed present in this build's help output.
    VLLM_VERSION_FLAGS=""
    if _vllm_has_flag "--disable-log-requests"; then
        VLLM_VERSION_FLAGS="$VLLM_VERSION_FLAGS --disable-log-requests"
    else
        log "WARNING: --disable-log-requests not found in this vLLM build — skipping"
    fi
    if _vllm_has_flag "--uvicorn-log-level"; then
        VLLM_VERSION_FLAGS="$VLLM_VERSION_FLAGS --uvicorn-log-level warning"
    else
        log "WARNING: --uvicorn-log-level not found in this vLLM build — skipping"
    fi
    [ -n "$VLLM_VERSION_FLAGS" ] && log "Applying capability-confirmed vLLM flags:$VLLM_VERSION_FLAGS"
    # ─────────────────────────────────────────────────────────────────────────

    log "SWARM_MAX_WORKERS=$SWARM_MAX_WORKERS (passed to Claw Runner)"

    VLLM_CMD="python3 -m vllm.entrypoints.openai.api_server \
        --model $MODEL_DIR \
        --host 0.0.0.0 \
        --port $VLLM_INTERNAL_PORT \
        --tensor-parallel-size $NUM_GPUS \
        --max-model-len $VLLM_MAX_MODEL_LEN \
        --max-num-seqs $VLLM_MAX_NUM_SEQS \
        --gpu-memory-utilization 0.92 \
        --served-model-name $SERVED_MODEL_NAME \
        $VLLM_VERSION_FLAGS \
        $VLLM_EXTRA_ARGS"

    eval "$VLLM_CMD" > /var/log/vllm-server.log 2>&1 &
    VLLM_PID=$!
    log "vLLM server started (PID: $VLLM_PID)"

    log "Starting litellm proxy on port $VLLM_PORT (OpenAI + Anthropic API)..."
    litellm \
        --model openai/$SERVED_MODEL_NAME \
        --api_base "http://localhost:${VLLM_INTERNAL_PORT}/v1" \
        --api_key not-needed \
        --host 0.0.0.0 \
        --port "$VLLM_PORT" \
        > /var/log/litellm.log 2>&1 &
    LITELLM_PID=$!
    log "litellm proxy started (PID: $LITELLM_PID)"

    log "Waiting for vLLM to be ready (model loading may take a few minutes)..."
    _vllm_ready=0
    for i in $(seq 1 120); do
        if curl -sf "http://localhost:$VLLM_INTERNAL_PORT/health" > /dev/null 2>&1; then
            log "vLLM is ready!"
            _vllm_ready=1
            break
        fi
        sleep 5
    done
    if [ "$_vllm_ready" -eq 0 ]; then
        # vLLM warmup never completed within the 600s budget. Report a
        # structured cause so the cockpit can surface "vLLM warmup failed"
        # with a suggested next step (check VRAM, lower max-model-len, or
        # destroy + retry on a larger profile). Don't exit the subshell so
        # SSH and code-server stay reachable for the user to investigate.
        report_failure "vllm_warmup_failed" "vLLM did not respond to /health within 600s — check /var/log/vllm-server.log"
    fi

    log "Configuring claw-code CLI..."
    export ANTHROPIC_BASE_URL="http://localhost:${VLLM_PORT}"
    export ANTHROPIC_API_KEY="not-needed"
    echo "ANTHROPIC_BASE_URL=http://localhost:${VLLM_PORT}" >> /etc/environment
    echo "ANTHROPIC_API_KEY=not-needed" >> /etc/environment
    echo "export ANTHROPIC_BASE_URL=http://localhost:${VLLM_PORT}" >> /root/.bashrc
    echo "export ANTHROPIC_API_KEY=not-needed" >> /root/.bashrc
    log "claw-code configured: ANTHROPIC_BASE_URL -> litellm proxy (port $VLLM_PORT)"

    if [ "$_vllm_ready" -eq 1 ]; then
        echo "llm_ready" > "$STATUS_FILE"
        report_status "llm_ready"
    fi
    log "=== MIZI Coding Environment Fully Ready (vLLM online) ==="
    log "  vLLM API:      http://localhost:$VLLM_INTERNAL_PORT/v1 (OpenAI format)"
    log "  LLM Proxy:     http://localhost:$VLLM_PORT (OpenAI + Anthropic via litellm)"
    log "  Bolt.diy:      http://localhost:$BOLT_PORT (proxied on 5180)"
    log "  code-server:   http://localhost:$CODE_SERVER_PORT"
    log "  Claw Runner:   http://localhost:5181"

    # Keep vLLM alive
    while true; do
        if ! kill -0 $VLLM_PID 2>/dev/null; then
            log "WARNING: vLLM process died, restarting..."
            eval "$VLLM_CMD" > /var/log/vllm-server.log 2>&1 &
            VLLM_PID=$!
        fi
        sleep 30
    done
) &

log "Phase 2 (vLLM) starting in background — code-server and tools are already available"
log "  code-server:  http://localhost:$CODE_SERVER_PORT"
log "  Bolt.diy:     http://localhost:$BOLT_PORT (proxied with auth on 5180)"
log "  Claw Runner:  http://localhost:5181"
log "  LLM API:      http://localhost:$VLLM_PORT (online after model loads)"
log "  SSH:          port 22 (key-based only)"

# Keep container alive
wait
