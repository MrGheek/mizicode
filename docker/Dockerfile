ARG CUDA_VERSION=12.4.0
ARG UBUNTU_VERSION=22.04

# ── Stage 1: Build claw-code from source ──────────────────────────────────────
# Plain Ubuntu — no CUDA compiler needed for Rust, builds on any platform.
FROM ubuntu:${UBUNTU_VERSION} AS claw-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git curl pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

RUN git clone --depth 1 https://github.com/instructkr/claw-code /opt/claw-code-src && \
    cd /opt/claw-code-src/rust && \
    cargo build --release && \
    cp target/release/claw /usr/local/bin/claw

# ── Runtime image ──────────────────────────────────────────────────────────────
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu${UBUNTU_VERSION}

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    nginx \
    openssh-server \
    apache2-utils \
    python3 \
    python3-pip \
    build-essential \
    ca-certificates \
    vim \
    nano \
    htop \
    tmux \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Download pre-built llama.cpp server with CUDA support.
# Building from source requires nvcc which is unavailable on Mac/non-GPU machines.
# We discover the actual asset URL via the GitHub API so this works regardless
# of how the release filenames are structured in any given version.
RUN set -ex && \
    RELEASE=$(curl -fsSL https://api.github.com/repos/ggerganov/llama.cpp/releases/latest) && \
    TAG=$(echo "${RELEASE}" | jq -r '.tag_name') && \
    echo "Latest llama.cpp release: ${TAG}" && \
    ASSET_URL=$(echo "${RELEASE}" | jq -r '.assets[].browser_download_url' \
        | grep -v '\.sha256$' \
        | grep -iE 'cuda' \
        | grep -iE 'linux|ubuntu' \
        | grep -iE 'x64|amd64|x86_64' \
        | head -1) && \
    [ -n "${ASSET_URL}" ] || (echo "ERROR: No Linux x64 CUDA asset found in release ${TAG}" && exit 1) && \
    echo "Downloading ${ASSET_URL}..." && \
    curl -fsSL --max-time 600 "${ASSET_URL}" -o /tmp/llama-pkg && \
    if echo "${ASSET_URL}" | grep -q '\.zip$'; then \
        unzip -q /tmp/llama-pkg -d /tmp/llama; \
    else \
        mkdir -p /tmp/llama && tar -xf /tmp/llama-pkg -C /tmp/llama; \
    fi && \
    BIN=$(find /tmp/llama -name "llama-server" -type f | head -1) && \
    [ -n "${BIN}" ] || (echo "ERROR: llama-server binary not found in archive" && exit 1) && \
    install -m 755 "${BIN}" /usr/local/bin/llama-server && \
    rm -rf /tmp/llama-pkg /tmp/llama

COPY --from=claw-builder /usr/local/bin/claw /usr/local/bin/claw

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm@9 && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://code-server.dev/install.sh | sh

RUN pip3 install --no-cache-dir huggingface-hub

RUN git clone --depth 1 https://github.com/stackblitz-labs/bolt.diy /opt/bolt-diy && \
    cd /opt/bolt-diy && \
    pnpm install --frozen-lockfile || pnpm install

RUN git clone --depth 1 https://github.com/instructkr/claw-code /opt/claw-code

RUN mkdir -p /run/sshd /workspace/models /workspace/projects /var/log && \
    git config --global --add safe.directory /workspace/projects && \
    git config --global --add safe.directory '*'

COPY onstart.sh /opt/onstart.sh
COPY claw-runner.js /opt/claw-runner.js
RUN chmod +x /opt/onstart.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -sf http://localhost:8081/health | grep -q "ok" || exit 1

EXPOSE 5180 5181 8080 8081 3000 22

CMD ["/opt/onstart.sh"]
