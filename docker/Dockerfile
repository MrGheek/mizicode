ARG CUDA_VERSION=12.4.0
ARG UBUNTU_VERSION=22.04

FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION} AS builder

ARG LLAMA_CUDA_ARCH=all

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    curl \
    wget \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggerganov/llama.cpp /opt/llama.cpp && \
    cd /opt/llama.cpp && \
    cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=${LLAMA_CUDA_ARCH} && \
    cmake --build build --config Release -j$(nproc) && \
    cp build/bin/llama-server /usr/local/bin/llama-server

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

RUN git clone --depth 1 https://github.com/instructkr/claw-code /opt/claw-code-src && \
    cd /opt/claw-code-src/rust && \
    cargo build --release && \
    cp target/release/claw /usr/local/bin/claw

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

COPY --from=builder /usr/local/bin/llama-server /usr/local/bin/llama-server
COPY --from=builder /usr/local/bin/claw /usr/local/bin/claw

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
RUN chmod +x /opt/onstart.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -sf http://localhost:8081/health | grep -q "ok" || exit 1

EXPOSE 5180 8080 8081 3000 22

CMD ["/opt/onstart.sh"]
