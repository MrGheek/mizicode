#!/bin/bash
set -e

LOG_FILE="/var/log/onstart.log"
STATUS_FILE="/tmp/instance-status"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

set_status() {
    echo "$1" > "$STATUS_FILE"
    log "STATUS: $1"
}

# Report phase to the OmniQL dashboard API so the boot log updates in real time.
# OMNIQL_CALLBACK_URL and OMNIQL_MEM_AUTH_TOKEN are injected by the API server
# into the onstart environment. Safe no-op if not set.
report_status() {
    local _phase="$1"
    local _msg="$2"
    if [ -z "${OMNIQL_CALLBACK_URL:-}" ]; then
        return 0
    fi
    local _payload
    if [ -n "$_msg" ]; then
        _payload="{\"status\":\"${_phase}\",\"message\":\"${_msg}\"}"
    else
        _payload="{\"status\":\"${_phase}\"}"
    fi
    curl -sf -X POST "${OMNIQL_CALLBACK_URL}" \
        -H "Authorization: Bearer ${OMNIQL_MEM_AUTH_TOKEN:-}" \
        -H "Content-Type: application/json" \
        -d "$_payload" \
        --max-time 10 \
        >> "$LOG_FILE" 2>&1 || log "WARNING: status callback failed (phase: $_phase) — dashboard may lag"
}

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

log "=== OmniQL Coding Environment Starting ==="
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
node /opt/claw-runner.js > /var/log/claw-runner.log 2>&1 &
log "Claw Task Runner started"

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
NGINX_AUTH_USER="${NGINX_AUTH_USER:-omniql}"
NGINX_AUTH_PASS="${NGINX_AUTH_PASS:-$CODE_SERVER_PASSWORD}"
htpasswd -cb /etc/nginx/.htpasswd "$NGINX_AUTH_USER" "$NGINX_AUTH_PASS" 2>/dev/null
log "Nginx credentials — user: $NGINX_AUTH_USER, pass: in /workspace/.code-server-password"

cat > /etc/nginx/sites-available/preview << 'NGINX'
server {
    listen 3000;
    server_name _;
    auth_basic "OmniQL Preview";
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
    auth_basic "OmniQL Bolt.diy";
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
    auth_basic "OmniQL Claw Runner";
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
        auth_basic "OmniQL";
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
            printf '    location /shared/ {\n        auth_basic "OmniQL Shared";\n        auth_basic_user_file %s;\n        proxy_pass http://localhost:%s;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_read_timeout 86400;\n    }\n' \
                "$_SHARED_HTPASSWD" "$_TM_INT_PORT" \
                >> /etc/nginx/sites-available/team-ide
        else
            printf '    location %s {\n        auth_basic "OmniQL - %s";\n        auth_basic_user_file /etc/nginx/.htpasswd-%s;\n        proxy_pass http://localhost:%s;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_read_timeout 86400;\n    }\n' \
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
# FLOATR_ACTIVE_BUNDLE_B64 is a base64-encoded JSON payload containing:
#   - bundleSlug, tokenMode, skills[], systemPromptFragment
# ─────────────────────────────────────────────────────────────────────────────
if [ -n "${FLOATR_ACTIVE_BUNDLE_B64:-}" ]; then
    log "=== Phase 1.5: Smart Skills bundle activation ==="
    set_status "skills_compiling"
    report_status "skills_compiling" "Activating Smart Skills bundle..."

    FLOATR_DIR="/workspace/.floatr"
    SKILLS_DIR="$FLOATR_DIR/skills"
    PROMPTS_DIR="/workspace/.floatr/prompts"
    mkdir -p "$SKILLS_DIR" "$PROMPTS_DIR"

    SKILL_PROMPTS_DIR="$PROMPTS_DIR/skills"
    mkdir -p "$SKILL_PROMPTS_DIR"

    # Decode and write the bundle JSON
    if printf '%s' "$FLOATR_ACTIVE_BUNDLE_B64" | base64 -d > "$SKILLS_DIR/active-bundle.json" 2>/dev/null; then
        log "Smart Skills: active-bundle.json written to $SKILLS_DIR"

        if command -v jq > /dev/null 2>&1; then
            BUNDLE_SLUG=$(jq -r '.bundleSlug // "unknown"' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
            TOKEN_MODE=$(jq -r '.tokenMode // "core"' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
            SKILL_COUNT=$(jq '.skills | length' "$SKILLS_DIR/active-bundle.json" 2>/dev/null || echo "0")
            log "Smart Skills: bundle=$BUNDLE_SLUG tokenMode=$TOKEN_MODE skillCount=$SKILL_COUNT"

            # Write token-mode.json to floatr root (not skills/) for runtime layer inspection
            printf '{"tokenMode":"%s","bundleSlug":"%s","skillCount":%s,"activatedAt":"%s"}\n' \
                "$TOKEN_MODE" "$BUNDLE_SLUG" "$SKILL_COUNT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                > "$FLOATR_DIR/token-mode.json"
            log "Smart Skills: token-mode.json written to $FLOATR_DIR/token-mode.json"

            # Write the combined system prompt fragment
            PROMPT_FRAGMENT=$(jq -r '.systemPromptFragment // empty' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
            if [ -n "$PROMPT_FRAGMENT" ]; then
                printf '%s\n' "$PROMPT_FRAGMENT" > "$PROMPTS_DIR/active-bundle.md"
                log "Smart Skills: prompt fragment written to $PROMPTS_DIR/active-bundle.md"
                echo "FLOATR_SKILLS_PROMPT_PATH=$PROMPTS_DIR/active-bundle.md" >> /etc/environment
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
        log "WARNING: Failed to decode FLOATR_ACTIVE_BUNDLE_B64 — Smart Skills will be unavailable this session"
    fi
else
    log "No Smart Skills bundle configured for this session — skipping Phase 1.5"
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1.6: Repo Intelligence daemon (async, non-blocking)
# Starts the repo-indexer in daemon (polling) mode if OMNIQL_SESSION_ID is set.
# The daemon polls for queued indexing jobs and processes them automatically.
# FLOATR_REPO_JOB_ID can be pre-set to run a specific job immediately.
# Hard limits: REPO_INDEX_MAX_DURATION_MS (default 300000ms = 5min).
# ─────────────────────────────────────────────────────────────────────────────
REPO_INTEL_DIR="/opt/repo-intelligence"
FLOATR_DIR="/workspace/.floatr"
mkdir -p "$FLOATR_DIR"

if [ -n "${OMNIQL_SESSION_ID:-}" ] && [ -f "${REPO_INTEL_DIR}/repo-indexer.mjs" ]; then
    log "=== Phase 1.6: Starting Repo Intelligence daemon (session ${OMNIQL_SESSION_ID}) ==="
    export FLOATR_REPO_PATH="${FLOATR_REPO_PATH:-/workspace/projects}"
    export REPO_INDEX_POLL_INTERVAL_SECS="${REPO_INDEX_POLL_INTERVAL_SECS:-30}"
    export REPO_INDEX_MAX_DURATION_MS="${REPO_INDEX_MAX_DURATION_MS:-300000}"

    node "${REPO_INTEL_DIR}/repo-indexer.mjs" \
        >> /var/log/repo-indexer.log 2>&1 &
    REPO_INDEXER_PID=$!
    log "Repo Intelligence: daemon started (PID ${REPO_INDEXER_PID}), polling every ${REPO_INDEX_POLL_INTERVAL_SECS}s"
    log "Repo Intelligence: tail /var/log/repo-indexer.log to monitor progress"
else
    if [ -z "${OMNIQL_SESSION_ID:-}" ]; then
        log "Repo Intelligence: OMNIQL_SESSION_ID not set — skipping Phase 1.6"
    else
        log "WARNING: Repo Intelligence scripts not found at ${REPO_INTEL_DIR} — skipping Phase 1.6"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1.7: Context Shield + Working State Continuity provisioning
# Provisions the per-session SQLite event journal, creates the artifacts
# directory, installs floatr_execute CLI wrapper, and runs artifact cleanup.
# Non-blocking: failures are logged but do not abort startup.
# ─────────────────────────────────────────────────────────────────────────────
log "=== Phase 1.7: Context Shield + Working State Continuity ==="

FLOATR_DIR="/workspace/.floatr"
ARTIFACTS_DIR="$FLOATR_DIR/artifacts"
STATE_DB="$FLOATR_DIR/session-state.db"
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

# Install floatr_execute / floatr_execute_file / floatr_batch_execute wrappers
# These are callable by the claw model via its bash tool.
if [ -f "$SHIELD_SCRIPT" ]; then
    cat > /usr/local/bin/floatr_execute << WRAPPER
#!/bin/bash
# floatr_execute — shielded command execution (Context Shield)
# Usage: floatr_execute <command and args...>
exec node "${SHIELD_SCRIPT}" exec "\$@"
WRAPPER
    chmod +x /usr/local/bin/floatr_execute

    cat > /usr/local/bin/floatr_execute_file << WRAPPER
#!/bin/bash
# floatr_execute_file — shielded file read (Context Shield)
# Usage: floatr_execute_file <path>
exec node "${SHIELD_SCRIPT}" exec-file "\$@"
WRAPPER
    chmod +x /usr/local/bin/floatr_execute_file

    cat > /usr/local/bin/floatr_batch_execute << WRAPPER
#!/bin/bash
# floatr_batch_execute — shielded batch execution (Context Shield)
# Usage: floatr_batch_execute '<json commands array>'
exec node "${SHIELD_SCRIPT}" batch "\$@"
WRAPPER
    chmod +x /usr/local/bin/floatr_batch_execute

    cat > /usr/local/bin/floatr_stats << WRAPPER
#!/bin/bash
# floatr_stats — shielded execution statistics
exec node "${SHIELD_SCRIPT}" stats
WRAPPER
    chmod +x /usr/local/bin/floatr_stats

    cat > /usr/local/bin/floatr_doctor << WRAPPER
#!/bin/bash
# floatr_doctor — shield health diagnostics
exec node "${SHIELD_SCRIPT}" doctor
WRAPPER
    chmod +x /usr/local/bin/floatr_doctor

    log "Context Shield: floatr_execute / floatr_execute_file / floatr_batch_execute / floatr_stats / floatr_doctor installed to /usr/local/bin/"

    # Run artifact cleanup in background (remove stale artifacts from prior runs)
    node "$SHIELD_SCRIPT" cleanup >> "$LOG_FILE" 2>&1 &
    log "Context Shield: background artifact cleanup started"
else
    log "Context Shield: context-shield.mjs not found at $SHIELD_SCRIPT — CLI wrappers not installed"
fi

# Write boot event to the journal
if [ -f "$STATE_SCRIPT" ]; then
    _BOOT_EVENT="{\"actor_type\":\"onstart\",\"event_type\":\"session_boot\",\"payload\":{\"sessionId\":\"${OMNIQL_SESSION_ID:-unknown}\"}}"
    node "$STATE_SCRIPT" append-event "$_BOOT_EVENT" >> "$LOG_FILE" 2>&1 || true
fi

log "=== Phase 1.7 done — Context Shield provisioned ==="

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2: Model download + vLLM + litellm in background
# ─────────────────────────────────────────────────────────────────────────────
log "Starting LLM backend in background..."

(
    MODEL_DIR="$MODEL_BASE_PATH/$MODEL_QUANT"

    if [ -d "$MODEL_DIR" ] && ls "$MODEL_DIR"/*.safetensors > /dev/null 2>&1; then
        log "Model found at $MODEL_DIR — skipping download"
    else
        echo "downloading" > "$STATUS_FILE"
        report_status "downloading"
        log "Downloading model $MODEL_REPO to $MODEL_DIR — this may take a while..."
        mkdir -p "$MODEL_DIR"
        retry huggingface-cli download "$MODEL_REPO" \
            --local-dir "$MODEL_DIR" \
            --local-dir-use-symlinks False \
            --resume-download
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
    #   vLLM 0.6.0+ partial-prefill tuning.
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
    for i in $(seq 1 120); do
        if curl -sf "http://localhost:$VLLM_INTERNAL_PORT/health" > /dev/null 2>&1; then
            log "vLLM is ready!"
            break
        fi
        if [ $i -eq 120 ]; then
            log "WARNING: vLLM did not respond within 600 seconds"
        fi
        sleep 5
    done

    log "Configuring claw-code CLI..."
    export ANTHROPIC_BASE_URL="http://localhost:${VLLM_PORT}"
    export ANTHROPIC_API_KEY="not-needed"
    echo "ANTHROPIC_BASE_URL=http://localhost:${VLLM_PORT}" >> /etc/environment
    echo "ANTHROPIC_API_KEY=not-needed" >> /etc/environment
    echo "export ANTHROPIC_BASE_URL=http://localhost:${VLLM_PORT}" >> /root/.bashrc
    echo "export ANTHROPIC_API_KEY=not-needed" >> /root/.bashrc
    log "claw-code configured: ANTHROPIC_BASE_URL -> litellm proxy (port $VLLM_PORT)"

    echo "llm_ready" > "$STATUS_FILE"
    report_status "llm_ready"
    log "=== OmniQL Coding Environment Fully Ready (vLLM online) ==="
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
