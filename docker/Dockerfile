ARG CUDA_VERSION=12.4.0
ARG UBUNTU_VERSION=22.04

# ── Stage 1: Build llama.cpp with CUDA ────────────────────────────────────────
# Requires Linux x86_64 — build via GitHub Actions, not Docker Desktop on Mac.
FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION} AS llama-builder

# Single arch (80 = A100/sm_80) with PTX included.
# CUDA JIT-compiles PTX for any newer GPU (RTX 3090/4090, H100) at first run.
# Compiling 4 arches OOMs GitHub Actions' 7GB RAM after ~90 min.
ARG LLAMA_CUDA_ARCH=80

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git curl wget pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggml-org/llama.cpp /opt/llama.cpp && \
    cd /opt/llama.cpp && \
    cmake -B build \
        -DGGML_CUDA=ON \
        -DGGML_NATIVE=OFF \
        -DCMAKE_CUDA_ARCHITECTURES="${LLAMA_CUDA_ARCH}" \
        -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build --config Release -j1 && \
    cp build/bin/llama-server /usr/local/bin/llama-server

# ── Stage 2: Build claw-code from Rust source ─────────────────────────────────
FROM ubuntu:${UBUNTU_VERSION} AS claw-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git curl pkg-config libssl-dev ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Disable interactive credential prompts — required for non-TTY Docker builds
ENV GIT_TERMINAL_PROMPT=0

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

RUN git clone --depth 1 https://github.com/ultraworkers/claw-code /opt/claw-code-src && \
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

COPY --from=llama-builder /usr/local/bin/llama-server /usr/local/bin/llama-server
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

RUN git clone --depth 1 https://github.com/ultraworkers/claw-code /opt/claw-code

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
