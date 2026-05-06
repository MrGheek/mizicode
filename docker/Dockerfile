ARG UBUNTU_VERSION=22.04
ARG CUDA_VERSION=12.4.1

# ── Stage 1: Build claw-code from bundled Rust source ─────────────────────────
# Source is in docker/claw-code-src — no git clone or auth required.
FROM ubuntu:${UBUNTU_VERSION} AS claw-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

COPY claw-code-src/claw-code-main /opt/claw-code-src
RUN cd /opt/claw-code-src/rust && \
    cargo build --release && \
    cp target/release/claw /usr/local/bin/claw

# ── Runtime image ──────────────────────────────────────────────────────────────
# Use cudnn-runtime for vLLM compatibility (includes cuDNN shared libs)
FROM nvidia/cuda:${CUDA_VERSION}-cudnn-runtime-ubuntu${UBUNTU_VERSION}

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

# vLLM: high-throughput inference engine with PagedAttention.
# Pinned to an exact version for reproducible builds.
# Minimum compatibility requirements for active model profiles:
#   - GLM-5.1 FP8: requires >=0.19.0 for --tool-call-parser glm47,
#     --reasoning-parser glm45, and --speculative-config.method mtp
#   - Qwen3-Coder-Next: requires >=0.8.4 for Qwen3 architecture support
#   - MiniMax M2.5: requires >=0.8.4 for updated MoE kernel support
# Bump this version after validating new profiles on real GPU hardware.
# Uses CUDA 12.4 wheels from PyPI.
RUN pip3 install --no-cache-dir \
    "vllm==0.19.0" \
    --extra-index-url https://download.pytorch.org/whl/cu124

# litellm proxy: accepts both OpenAI /v1/chat/completions and Anthropic /v1/messages,
# forwarding to vLLM. Lets claw-code use Anthropic format seamlessly.
RUN pip3 install --no-cache-dir litellm

# transformers >=5.3.0 required by GLM-5.1 FP8 tokeniser and GLM-4 tool-call parser.
# Also benefits Qwen3 and MiniMax M2.5 which rely on recent transformers features.
RUN pip3 install --no-cache-dir "transformers>=5.3.0"

# DeepGEMM: optional FP8 GEMM kernel library used by vLLM for GLM-5.1 FP8 inference.
# Provides faster FP8 matrix multiply on H100/H200 vs the default triton kernels.
# Pinned to a specific commit SHA for reproducible builds.
# To update: find the desired commit at https://github.com/deepseek-ai/DeepGEMM
# and set DEEPGEMM_SHA build arg: docker build --build-arg DEEPGEMM_SHA=<sha> ...
# Falls back gracefully if CUDA compilation is unavailable (runtime image lacks
# nvcc); vLLM's built-in triton FP8 kernels remain fully functional without it.
# NOTE: full compilation requires the cudnn-devel base image (see follow-up task).
ARG DEEPGEMM_SHA=a7b3d1e
RUN pip3 install --no-cache-dir \
    "git+https://github.com/deepseek-ai/DeepGEMM.git@${DEEPGEMM_SHA}" \
    || echo "WARNING: DeepGEMM build failed (SHA=${DEEPGEMM_SHA}) — FP8 inference will use vLLM built-in kernels (fully functional, slightly slower on H100/H200)"

# HuggingFace CLI for volume provisioning (one-time model download)
RUN pip3 install --no-cache-dir huggingface-hub

COPY --from=claw-builder /usr/local/bin/claw /usr/local/bin/claw

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm@9 && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://code-server.dev/install.sh | sh

RUN git clone --depth 1 https://github.com/stackblitz-labs/bolt.diy /opt/bolt-diy && \
    cd /opt/bolt-diy && \
    pnpm install --frozen-lockfile || pnpm install

COPY claw-code-src/claw-code-main /opt/claw-code

RUN mkdir -p /run/sshd /workspace/models /workspace/projects /var/log && \
    git config --global --add safe.directory /workspace/projects && \
    git config --global --add safe.directory '*'

COPY onstart.sh /opt/onstart.sh
COPY claw-bridge.mjs /opt/claw-bridge.mjs
COPY claw-runner.js /opt/claw-runner.js
COPY scripts/ /opt/repo-intelligence/
RUN cd /opt/repo-intelligence && npm install --production --prefer-offline && \
    node -e "require('better-sqlite3'); console.log('[repo-intelligence] better-sqlite3 OK')" 2>/dev/null || \
    echo "[repo-intelligence] WARN: native modules may be missing — indexer will use fallback mode"
RUN chmod +x /opt/onstart.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -sf http://localhost:8081/health || exit 1

EXPOSE 5180 5181 8080 8081 3000 22

CMD ["/opt/onstart.sh"]
