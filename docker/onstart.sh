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

MODEL_REPO="${MODEL_REPO:-unsloth/Kimi-K2.5-GGUF}"
MODEL_QUANT="${MODEL_QUANT:-UD-TQ1_0}"
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-32768}"
LLAMA_BATCH_SIZE="${LLAMA_BATCH_SIZE:-512}"
LLAMA_EXTRA_ARGS="${LLAMA_EXTRA_ARGS:-}"
LLAMA_PORT="${LLAMA_PORT:-8081}"
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"
BOLT_PORT="${BOLT_PORT:-5173}"
PREVIEW_PORT="${PREVIEW_PORT:-3000}"
VOLUME_MODEL_PATH="${VOLUME_MODEL_PATH:-/workspace/models}"
if [ -z "$CODE_SERVER_PASSWORD" ]; then
    CODE_SERVER_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
    echo "$CODE_SERVER_PASSWORD" > /workspace/.code-server-password
    chmod 600 /workspace/.code-server-password
    log "code-server password generated and stored at /workspace/.code-server-password (readable after SSH)"
fi

log "=== OmniQL Coding Environment Starting ==="
log "Model: $MODEL_REPO / $MODEL_QUANT"
log "Context: $LLAMA_CTX_SIZE, Batch: $LLAMA_BATCH_SIZE"

set_status "downloading"

MODEL_DIR="$VOLUME_MODEL_PATH/$MODEL_QUANT"
if [ -d "$MODEL_DIR" ] && [ "$(ls -A $MODEL_DIR/*.gguf 2>/dev/null)" ]; then
    log "Model found at $MODEL_DIR, skipping download"
else
    log "Downloading model $MODEL_REPO ($MODEL_QUANT)..."
    mkdir -p "$MODEL_DIR"
    retry huggingface-cli download "$MODEL_REPO" \
        --include "${MODEL_QUANT}/*" \
        --local-dir "$MODEL_DIR" \
        --local-dir-use-symlinks False \
        --resume-download
    log "Model download complete"
fi

GGUF_FILES=$(find "$MODEL_DIR" -name "*.gguf" -type f | sort | head -1)
if [ -z "$GGUF_FILES" ]; then
    GGUF_FILES=$(find "$MODEL_DIR/$MODEL_QUANT" -name "*.gguf" -type f | sort | head -1)
fi

if [ -z "$GGUF_FILES" ]; then
    log "ERROR: No GGUF files found in $MODEL_DIR"
    set_status "error: no model files found"
    exit 1
fi

log "Using model file: $GGUF_FILES"

set_status "starting"

log "Starting llama.cpp server on port $LLAMA_PORT..."
llama-server \
    --model "$GGUF_FILES" \
    --port "$LLAMA_PORT" \
    --host 0.0.0.0 \
    --n-gpu-layers 999 \
    --split-mode layer \
    --ctx-size "$LLAMA_CTX_SIZE" \
    --batch-size "$LLAMA_BATCH_SIZE" \
    $LLAMA_EXTRA_ARGS \
    > /var/log/llama-server.log 2>&1 &
LLAMA_PID=$!
log "llama.cpp server started (PID: $LLAMA_PID)"

log "Starting code-server on port $CODE_SERVER_PORT..."
PASSWORD="$CODE_SERVER_PASSWORD" code-server \
    --bind-addr 0.0.0.0:$CODE_SERVER_PORT \
    --auth password \
    --disable-telemetry \
    /workspace/projects \
    > /var/log/code-server.log 2>&1 &
log "code-server started"

log "Configuring Bolt.diy..."
cd /opt/bolt-diy
cat > .env.local << EOF
OPENAI_LIKE_API_BASE_URL=http://localhost:${LLAMA_PORT}/v1
OPENAI_LIKE_API_KEY=not-needed
DEFAULT_NUM_CTX=${LLAMA_CTX_SIZE}
EOF

log "Starting Bolt.diy on port $BOLT_PORT..."
PORT=$BOLT_PORT pnpm run dev > /var/log/bolt-diy.log 2>&1 &
log "Bolt.diy started"

log "Configuring nginx with basic auth for exposed services..."
NGINX_AUTH_USER="${NGINX_AUTH_USER:-omniql}"
NGINX_AUTH_PASS="${NGINX_AUTH_PASS:-$CODE_SERVER_PASSWORD}"
htpasswd -cb /etc/nginx/.htpasswd "$NGINX_AUTH_USER" "$NGINX_AUTH_PASS" 2>/dev/null
log "Nginx auth credentials - user: $NGINX_AUTH_USER, pass: stored in /workspace/.code-server-password"

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
NGINX
ln -sf /etc/nginx/sites-available/preview /etc/nginx/sites-enabled/preview
rm -f /etc/nginx/sites-enabled/default
nginx -t && nginx
log "nginx proxy started (preview: $PREVIEW_PORT, bolt-auth: 5180) with basic auth"

log "Starting SSH server with key-based auth only..."
mkdir -p /root/.ssh
chmod 700 /root/.ssh
ssh-keygen -A
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
echo "PermitRootLogin prohibit-password" >> /etc/ssh/sshd_config
/usr/sbin/sshd
log "SSH server started (key-based auth only)"

log "Waiting for llama.cpp to be ready..."
for i in $(seq 1 120); do
    if curl -s http://localhost:$LLAMA_PORT/health | grep -q "ok"; then
        log "llama.cpp is ready!"
        break
    fi
    if [ $i -eq 120 ]; then
        log "WARNING: llama.cpp did not respond within 120 seconds"
    fi
    sleep 5
done

log "Configuring claw-code CLI..."
mkdir -p /root/.config/claw
cat > /root/.config/claw/settings.json << EOF
{
  "model": "kimi-k2",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:${LLAMA_PORT}",
    "ANTHROPIC_API_KEY": "not-needed"
  }
}
EOF
export ANTHROPIC_BASE_URL="http://localhost:${LLAMA_PORT}"
export ANTHROPIC_API_KEY="not-needed"
echo "ANTHROPIC_BASE_URL=http://localhost:${LLAMA_PORT}" >> /etc/environment
echo "ANTHROPIC_API_KEY=not-needed" >> /etc/environment
echo "export ANTHROPIC_BASE_URL=http://localhost:${LLAMA_PORT}" >> /root/.bashrc
echo "export ANTHROPIC_API_KEY=not-needed" >> /root/.bashrc
log "claw-code configured: ANTHROPIC_BASE_URL -> llama.cpp (port $LLAMA_PORT)"

set_status "ready"
touch /tmp/instance-ready

log "=== OmniQL Coding Environment Ready ==="
log "  claw (agent): run 'claw' in any terminal"
log "  Bolt.diy:     http://localhost:$BOLT_PORT (proxied with auth on 5180)"
log "  code-server:  http://localhost:$CODE_SERVER_PORT"
log "  llama.cpp:    http://localhost:$LLAMA_PORT (OpenAI + Anthropic API)"
log "  Preview:      http://localhost:$PREVIEW_PORT"
log "  SSH:          port 22 (key-based only)"

while true; do
    if ! kill -0 $LLAMA_PID 2>/dev/null; then
        log "WARNING: llama.cpp process died, restarting..."
        llama-server \
            --model "$GGUF_FILES" \
            --port "$LLAMA_PORT" \
            --host 0.0.0.0 \
            --n-gpu-layers 999 \
            --split-mode layer \
            --ctx-size "$LLAMA_CTX_SIZE" \
            --batch-size "$LLAMA_BATCH_SIZE" \
            $LLAMA_EXTRA_ARGS \
            > /var/log/llama-server.log 2>&1 &
        LLAMA_PID=$!
    fi
    sleep 30
done
