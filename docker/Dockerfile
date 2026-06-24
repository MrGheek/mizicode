# ── MIZI Workspace Dockerfile ──────────────────────────────────────────────────
# Workspace image for Fly.io NIM sessions.
# Registry: registry.fly.io/mizi-workspace:latest
# App:      mizi-workspace  (separate from mizi-api — see fly.workspace.toml)
#
# Build and push (from workspace root):
#   flyctl auth docker
#   docker build -t registry.fly.io/mizi-workspace:latest \
#       -f docker/Dockerfile .
#   docker push registry.fly.io/mizi-workspace:latest
#
# Or via flyctl (builds remotely, no local Docker needed):
#   flyctl deploy --app mizi-workspace \
#       --dockerfile docker/Dockerfile \
#       --image-label latest \
#       --strategy immediate
#
# No GPU, no vLLM, no CUDA.
# Inference routes to the NVIDIA NIM API (or any OpenAI-compatible endpoint)
# via LiteLLM proxy — the heavy lifting is done by the NIM API, not the machine.
#
# Services started by onstart.sh:
#   theia         — Eclipse Theia IDE on port 8080
#   claw-runner   — Claw Runner agent loop (Node.js, port 5181)
#   claw-bridge   — real-time bridge to the API server (WebSocket)
#   nginx         — reverse proxy and auth gate
#   nim-proxy     — OpenAI-compatible proxy → NIM API (port 8081)
# ───────────────────────────────────────────────────────────────────────────────

ARG UBUNTU_VERSION=22.04

# ── Stage 1: build claw binary from bundled Rust source ───────────────────────
FROM ubuntu:${UBUNTU_VERSION} AS claw-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

COPY docker/claw-code-src/claw-code-main /opt/claw-code-src
RUN cd /opt/claw-code-src/rust && \
    CARGO_PROFILE_RELEASE_OPT_LEVEL=0 \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=256 \
    cargo build --release && \
    cp target/release/claw /usr/local/bin/claw

# ── Stage 2: slim runtime — ubuntu only, no CUDA, no GPU stack ────────────────
FROM ubuntu:${UBUNTU_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    nginx \
    openssh-server \
    apache2-utils \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    make \
    g++ \
    ca-certificates \
    vim \
    nano \
    htop \
    tmux \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# litellm proxy: accepts OpenAI /v1/chat/completions and Anthropic /v1/messages,
# forwarding to the NIM API. Lets claw-code use Anthropic format seamlessly.
# Install base first (heavy) then [proxy] extras (lighter) so layer caching is efficient.
RUN pip3 install --no-cache-dir fastapi uvicorn httpx litellm
RUN pip3 install --no-cache-dir 'litellm[proxy]'

# Node.js 20 + pnpm (claw-runner.js, claw-bridge.mjs, bolt.diy dev server)
# python3+make+g++ must already be installed before pnpm install runs so that
# native addons (better-sqlite3) can compile without errors.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm@9 && \
    rm -rf /var/lib/apt/lists/*

# Theia IDE (pre-built, downloaded from GH Actions artifact)
# Built by .github/workflows/build-theia.yml.
# THEIA_ARTIFACT_URL should point to a GitHub release or actions artifact URL.
# Example: https://github.com/gheeklabs/mizi/releases/download/theia/latest.tar.gz
ARG THEIA_ARTIFACT_URL=https://github.com/gheeklabs/mizi/releases/download/theia/latest.tar.gz
RUN curl -fsSL "${THEIA_ARTIFACT_URL}" -o /tmp/mizi-theia.tar.gz && \
    mkdir -p /opt/mizi-theia && \
    tar xzf /tmp/mizi-theia.tar.gz -C /opt/mizi-theia/ && \
    rm /tmp/mizi-theia.tar.gz

# Claw binary from stage 1
COPY --from=claw-builder /usr/local/bin/claw /usr/local/bin/claw

# Claw source tree (claw-runner.js tooling reference)
COPY docker/claw-code-src/claw-code-main /opt/claw-code

RUN mkdir -p /run/sshd /workspace/models /workspace/projects /var/log && \
    git config --global --add safe.directory /workspace/projects && \
    git config --global --add safe.directory '*'

COPY docker/onstart.sh /opt/onstart.sh
COPY docker/claw-bridge.mjs /opt/claw-bridge.mjs
COPY docker/claw-runner.js /opt/claw-runner.js
COPY docker/scripts/ /opt/repo-intelligence/
# python3+make+g++ are already installed above so better-sqlite3 compiles cleanly.
RUN cd /opt/repo-intelligence && npm install --production --prefer-offline && \
    node -e "require('better-sqlite3'); console.log('[repo-intelligence] better-sqlite3 OK')" 2>/dev/null || \
    echo "[repo-intelligence] WARN: native modules may be missing — fallback mode"
RUN chmod +x /opt/onstart.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -sf http://localhost:8081/health/liveliness || exit 1

EXPOSE 8080 8081 5181 22

CMD ["/opt/onstart.sh"]
