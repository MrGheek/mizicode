ARG UBUNTU_VERSION=22.04

# ── Stage 1: Build claw-code from Rust source ─────────────────────────────────
# Plain Ubuntu — no CUDA compiler needed for Rust. Builds on any platform.
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

# ── Runtime: extend the official llama.cpp CUDA server image ──────────────────
# The llama-server binary is already compiled with full CUDA support.
# No nvcc or GPU needed at build time — works on Mac, Windows, Linux CI.
FROM ghcr.io/ggerganov/llama.cpp:server-cuda

# llama-server lives at /llama/llama-server in the base image; expose it in PATH
RUN ln -sf /llama/llama-server /usr/local/bin/llama-server

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
