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

MODEL_REPO="${MODEL_REPO:-moonshotai/Kimi-K2.5}"
MODEL_QUANT="${MODEL_QUANT:-kimi-k2.5}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-kimi-k2}"
VLLM_MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-32768}"
VLLM_MAX_NUM_SEQS="${VLLM_MAX_NUM_SEQS:-256}"
VLLM_EXTRA_ARGS="${VLLM_EXTRA_ARGS:-}"
NUM_GPUS="${NUM_GPUS:-1}"
MODEL_BASE_PATH="${MODEL_BASE_PATH:-/workspace/models}"

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

    SKILLS_DIR="/workspace/.floatr/skills"
    PROMPTS_DIR="/workspace/.floatr/prompts"
    mkdir -p "$SKILLS_DIR" "$PROMPTS_DIR"

    # Decode and write the bundle JSON
    if printf '%s' "$FLOATR_ACTIVE_BUNDLE_B64" | base64 -d > "$SKILLS_DIR/active-bundle.json" 2>/dev/null; then
        log "Smart Skills: active-bundle.json written to $SKILLS_DIR"

        # Extract and write the system prompt fragment for claw-code SYSTEM_PROMPT injection
        if command -v jq > /dev/null 2>&1; then
            PROMPT_FRAGMENT=$(jq -r '.systemPromptFragment // empty' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
            if [ -n "$PROMPT_FRAGMENT" ]; then
                printf '%s\n' "$PROMPT_FRAGMENT" > "$PROMPTS_DIR/active-bundle.md"
                log "Smart Skills: prompt fragment written to $PROMPTS_DIR/active-bundle.md"

                # Append to global environment so claw-runner can read it on startup
                echo "FLOATR_SKILLS_PROMPT_PATH=$PROMPTS_DIR/active-bundle.md" >> /etc/environment

                BUNDLE_SLUG=$(jq -r '.bundleSlug // "unknown"' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
                TOKEN_MODE=$(jq -r '.tokenMode // "core"' "$SKILLS_DIR/active-bundle.json" 2>/dev/null)
                SKILL_COUNT=$(jq '.skills | length' "$SKILLS_DIR/active-bundle.json" 2>/dev/null || echo "0")
                log "Smart Skills: bundle=$BUNDLE_SLUG tokenMode=$TOKEN_MODE skillCount=$SKILL_COUNT"
            fi
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

    VLLM_CMD="python3 -m vllm.entrypoints.openai.api_server \
        --model $MODEL_DIR \
        --host 0.0.0.0 \
        --port $VLLM_INTERNAL_PORT \
        --tensor-parallel-size $NUM_GPUS \
        --max-model-len $VLLM_MAX_MODEL_LEN \
        --max-num-seqs $VLLM_MAX_NUM_SEQS \
        --gpu-memory-utilization 0.92 \
        --served-model-name $SERVED_MODEL_NAME \
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
