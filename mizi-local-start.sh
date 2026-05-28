#!/usr/bin/env bash
# mizi-local-start.sh — Mizi-Local single-command setup and launcher
# Supports: Linux x86_64, Linux arm64, macOS arm64 (Apple Silicon), macOS x86_64
# Usage: bash mizi-local-start.sh [--no-ollama] [--model <model-id>] [--port <port>]
set -euo pipefail

MIZI_HOME="${MIZI_HOME:-$HOME/.mizi}"
MIZI_CONFIG="$MIZI_HOME/config.env"
MIZI_LOG="$MIZI_HOME/mizi.log"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
API_PORT="${API_PORT:-4000}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
SKIP_OLLAMA=false
REQUESTED_MODEL=""
INSTALL_SERVICES=false

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-ollama)   SKIP_OLLAMA=true; shift ;;
    --model)       REQUESTED_MODEL="$2"; shift 2 ;;
    --port)        DASHBOARD_PORT="$2"; shift 2 ;;
    --api-port)    API_PORT="$2"; shift 2 ;;
    --install-services) INSTALL_SERVICES=true; shift ;;
    --help|-h)
      echo "Usage: bash mizi-local-start.sh [--model <id>] [--port <port>] [--install-services] [--no-ollama]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Logging ───────────────────────────────────────────────────────────────────
log() { echo "[mizi] $*" | tee -a "$MIZI_LOG"; }
log_section() { echo "" | tee -a "$MIZI_LOG"; echo "── $* ──" | tee -a "$MIZI_LOG"; }

mkdir -p "$MIZI_HOME"
touch "$MIZI_LOG"

log "=== Mizi-Local Setup ==="
log "MIZI_HOME: $MIZI_HOME"

# ── OS / arch detection ───────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS="macOS"; OS_LABEL="macOS" ;;
  Linux)  OS_LABEL="Linux" ;;
  *)      echo "[mizi] Unsupported OS: $OS (Linux and macOS only)"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_LABEL="x64";   OLLAMA_ARCH="amd64" ;;
  arm64|aarch64) ARCH_LABEL="arm64"; OLLAMA_ARCH="arm64" ;;
  *)             echo "[mizi] Unsupported architecture: $ARCH"; exit 1 ;;
esac

log "Platform: $OS_LABEL/$ARCH_LABEL"

# ── Backend detection ─────────────────────────────────────────────────────────
log_section "Hardware detection"

BACKEND="cpu"
HAILO_DETECTED=false
NVIDIA_DETECTED=false
APPLE_SILICON=false

# NVIDIA
if command -v nvidia-smi &>/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)
  if [ -n "$GPU_NAME" ]; then
    log "NVIDIA GPU detected: $GPU_NAME"
    BACKEND="cuda"
    NVIDIA_DETECTED=true
  fi
fi

# Apple Silicon
if [ "$OS" = "macOS" ] && [ "$ARCH" = "arm64" ]; then
  CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)
  if echo "$CHIP" | grep -qi "Apple M"; then
    log "Apple Silicon detected: $CHIP"
    BACKEND="metal"
    APPLE_SILICON=true
  fi
fi

# Hailo
if command -v hailortcli &>/dev/null 2>&1; then
  HAILO_OUT=$(hailortcli fw-control identify 2>/dev/null || true)
  if echo "$HAILO_OUT" | grep -qi "hailo"; then
    log "Hailo NPU detected"
    HAILO_DETECTED=true
    if [ "$BACKEND" = "cpu" ]; then
      BACKEND="hailo"
    fi
  fi
fi

if [ "$NVIDIA_DETECTED" = false ] && [ "$APPLE_SILICON" = false ] && [ "$HAILO_DETECTED" = false ]; then
  log "No GPU/NPU detected — using CPU-only mode"
fi

log "Primary backend: $BACKEND"

# ── HailoRT installation ──────────────────────────────────────────────────────
if [ "$HAILO_DETECTED" = true ] && ! python3 -c 'import hailo_platform' &>/dev/null 2>&1; then
  log_section "Installing HailoRT Python package"
  if command -v pip3 &>/dev/null; then
    pip3 install hailort --quiet || log "WARNING: HailoRT Python package install failed — embedding may fall back to CPU"
  else
    log "WARNING: pip3 not found — cannot install HailoRT Python package"
  fi
fi

# ── Ollama installation ───────────────────────────────────────────────────────
if [ "$SKIP_OLLAMA" = false ]; then
  log_section "Ollama setup"

  if ! command -v ollama &>/dev/null 2>&1; then
    log "Ollama not found — installing..."

    if [ "$OS" = "macOS" ]; then
      if command -v brew &>/dev/null 2>&1; then
        log "Installing via Homebrew..."
        brew install ollama
      else
        log "Installing via official script..."
        curl -fsSL https://ollama.com/install.sh | sh
      fi
    else
      log "Installing via official script..."
      curl -fsSL https://ollama.com/install.sh | sh
    fi

    log "Ollama installed successfully"
  else
    log "Ollama already installed: $(ollama --version 2>/dev/null || true)"
  fi

  # Start Ollama if not running
  if ! curl -sf "http://localhost:$OLLAMA_PORT/api/version" &>/dev/null; then
    log "Starting Ollama..."
    if [ "$OS" = "macOS" ]; then
      ollama serve &>/dev/null &
    elif [ "$NVIDIA_DETECTED" = true ]; then
      # NVIDIA: let Ollama see all GPUs — do NOT set CUDA_VISIBLE_DEVICES.
      # Setting it to "" would hide all devices and force CPU-only inference.
      OLLAMA_RUNNERS="${BACKEND}" ollama serve >> "$MIZI_LOG" 2>&1 &
    else
      # No discrete GPU: explicitly hide CUDA devices to avoid Ollama probing
      # for GPUs that don't exist, which can add seconds of startup latency.
      CUDA_VISIBLE_DEVICES="" OLLAMA_RUNNERS="${BACKEND}" ollama serve >> "$MIZI_LOG" 2>&1 &
    fi
    OLLAMA_PID=$!
    log "Ollama starting (PID $OLLAMA_PID)..."
    sleep 3

    # Wait up to 15s for Ollama to be ready
    for i in $(seq 1 15); do
      if curl -sf "http://localhost:$OLLAMA_PORT/api/version" &>/dev/null; then
        log "Ollama ready"
        break
      fi
      sleep 1
    done
  else
    log "Ollama already running"
  fi

  # Pull recommended model if none requested and no models present
  MODELS=$(ollama list 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
  if [ "${MODELS:-0}" -eq 0 ] || [ -n "$REQUESTED_MODEL" ]; then
    MODEL_TO_PULL="${REQUESTED_MODEL}"

    if [ -z "$MODEL_TO_PULL" ]; then
      # Auto-select based on available memory
      TOTAL_MEM_GB=0
      if [ "$OS" = "macOS" ]; then
        TOTAL_MEM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
        TOTAL_MEM_GB=$((TOTAL_MEM_BYTES / 1024 / 1024 / 1024))
      else
        TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
        TOTAL_MEM_GB=$((TOTAL_MEM_KB / 1024 / 1024))
      fi

      log "Total memory: ${TOTAL_MEM_GB} GB"

      if [ "$TOTAL_MEM_GB" -lt 4 ]; then
        MODEL_TO_PULL="qwen2.5:1.5b"
      elif [ "$TOTAL_MEM_GB" -lt 8 ]; then
        MODEL_TO_PULL="qwen2.5-coder:3b"
      elif [ "$TOTAL_MEM_GB" -lt 16 ]; then
        MODEL_TO_PULL="qwen2.5-coder:7b"
      elif [ "$TOTAL_MEM_GB" -lt 32 ]; then
        MODEL_TO_PULL="qwen2.5-coder:14b"
      else
        MODEL_TO_PULL="qwen2.5-coder:32b"
      fi
    fi

    log "Pulling model: $MODEL_TO_PULL"
    ollama pull "$MODEL_TO_PULL" | tee -a "$MIZI_LOG" || log "WARNING: Model pull failed"
    log "Model ready: $MODEL_TO_PULL"
  else
    log "Existing models found — skipping pull"
  fi
fi

# ── Config file ───────────────────────────────────────────────────────────────
log_section "Writing config"

if [ ! -f "$MIZI_CONFIG" ]; then
  cat > "$MIZI_CONFIG" << EOF
# Mizi-Local configuration
# Generated by mizi-local-start.sh on $(date)

MIZI_DISTRIBUTION=local
MIZI_HOME=$MIZI_HOME

# Ollama
OLLAMA_BASE_URL=http://localhost:$OLLAMA_PORT

# Ports
PORT=$DASHBOARD_PORT
API_PORT=$API_PORT

# Backend detected: $BACKEND
MIZI_LOCAL_BACKEND=$BACKEND

# Database
MIZI_LOCAL_DB_PATH=$MIZI_HOME/local.db

# Workspace
MIZI_LOCAL_WORKSPACE=$MIZI_HOME/workspace

# Logging
LOG_LEVEL=info
EOF
  log "Config written: $MIZI_CONFIG"
else
  log "Config already exists: $MIZI_CONFIG (not overwritten)"
fi

# ── Service installation ──────────────────────────────────────────────────────
if [ "$INSTALL_SERVICES" = true ]; then
  log_section "Installing system services"

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [ "$OS" = "Linux" ]; then
    if command -v systemctl &>/dev/null; then
      SYSTEMD_DIR="/etc/systemd/system"
      for svc in mizi-api mizi-dashboard mizi-ollama; do
        SRC="$SCRIPT_DIR/local/service-files/systemd/${svc}.service"
        if [ -f "$SRC" ]; then
          sudo cp "$SRC" "$SYSTEMD_DIR/${svc}.service"
          sudo sed -i "s|{{MIZI_HOME}}|$MIZI_HOME|g" "$SYSTEMD_DIR/${svc}.service"
          sudo sed -i "s|{{USER}}|$(whoami)|g" "$SYSTEMD_DIR/${svc}.service"
          sudo sed -i "s|{{MIZI_INSTALL_DIR}}|$SCRIPT_DIR|g" "$SYSTEMD_DIR/${svc}.service"
          log "Installed: $SYSTEMD_DIR/${svc}.service"
        fi
      done
      sudo systemctl daemon-reload
      log "Run: sudo systemctl enable --now mizi-api mizi-dashboard mizi-ollama"
    else
      log "systemctl not found — skipping service install"
    fi

  elif [ "$OS" = "macOS" ]; then
    LAUNCHD_DIR="$HOME/Library/LaunchAgents"
    mkdir -p "$LAUNCHD_DIR"
    for plist in com.mizi.api com.mizi.ollama; do
      SRC="$SCRIPT_DIR/local/service-files/launchd/${plist}.plist"
      if [ -f "$SRC" ]; then
        DEST="$LAUNCHD_DIR/${plist}.plist"
        sed "s|{{MIZI_HOME}}|$MIZI_HOME|g; s|{{USER}}|$(whoami)|g; s|{{MIZI_INSTALL_DIR}}|$SCRIPT_DIR|g" "$SRC" > "$DEST"
        launchctl load "$DEST" 2>/dev/null || log "Note: launchctl load failed (may already be loaded)"
        log "Installed: $DEST"
      fi
    done
  fi
fi

# ── Start services ────────────────────────────────────────────────────────────
log_section "Starting Mizi services"

# Source config
set -o allexport
source "$MIZI_CONFIG"
set +o allexport

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIST="$SCRIPT_DIR/artifacts/api-server/dist/index.mjs"
DASHBOARD_DIST="$SCRIPT_DIR/artifacts/dashboard/dist"

if [ ! -f "$API_DIST" ]; then
  log "API server not built. Run: MIZI_DISTRIBUTION=local pnpm build"
  log "Or start in dev mode with: MIZI_DISTRIBUTION=local pnpm dev"
  exit 1
fi

# Start local ACP runner — Mizi-Local uses ACP (HTTP) instead of the legacy
# cloud WebSocket bridge for all claw task dispatch. The runner proxies tasks
# to the local Ollama instance on ACP_PORT (default 5185).
ACP_PORT="${ACP_PORT:-5185}"
ACP_RUNNER="$SCRIPT_DIR/local/acp-runner.mjs"
if [ -f "$ACP_RUNNER" ]; then
  log "Starting local ACP runner on port $ACP_PORT..."
  ACP_PORT="$ACP_PORT" OLLAMA_BASE_URL="$OLLAMA_BASE_URL" node "$ACP_RUNNER" >> "$MIZI_HOME/mizi-acp.log" 2>&1 &
  ACP_PID=$!
  log "ACP runner started (PID $ACP_PID)"
  # Give the runner a moment to bind its port before the API server tries to register
  sleep 0.5
else
  log "WARNING: ACP runner not found at $ACP_RUNNER — local task dispatch will fall back to direct Ollama chat"
fi

log "Starting API server on port $API_PORT..."
PORT="$API_PORT" ACP_PORT="$ACP_PORT" MIZI_DISTRIBUTION=local node "$API_DIST" >> "$MIZI_HOME/mizi-api.log" 2>&1 &
API_PID=$!
log "API server started (PID $API_PID)"

# Start dashboard static file server if built
DASHBOARD_SERVE="$SCRIPT_DIR/artifacts/dashboard/serve.mjs"
DASHBOARD_DIST_DIR="$SCRIPT_DIR/artifacts/dashboard/dist/public"

if [ -f "$DASHBOARD_SERVE" ]; then
  log "Starting dashboard server on port $DASHBOARD_PORT..."
  PORT="$DASHBOARD_PORT" MIZI_DISTRIBUTION=local node "$DASHBOARD_SERVE" >> "$MIZI_HOME/mizi-dashboard.log" 2>&1 &
  DASHBOARD_PID=$!
  log "Dashboard started (PID $DASHBOARD_PID)"
elif [ -d "$DASHBOARD_DIST_DIR" ]; then
  log "Starting dashboard via npx serve..."
  npx --yes serve -s "$DASHBOARD_DIST_DIR" -l "$DASHBOARD_PORT" >> "$MIZI_HOME/mizi-dashboard.log" 2>&1 &
  DASHBOARD_PID=$!
  log "Dashboard started via serve (PID $DASHBOARD_PID)"
else
  log "Dashboard not built — start it manually with: MIZI_DISTRIBUTION=local pnpm --filter @workspace/dashboard dev"
  DASHBOARD_PID=""
fi

log ""
log "=== Mizi-Local is running ==="
log "  Dashboard: http://localhost:$DASHBOARD_PORT"
log "  API:       http://localhost:$API_PORT/api"
log "  Chat:      http://localhost:$API_PORT/api/local/chat"
log "  Logs:      $MIZI_HOME/"
log ""
log "Press Ctrl+C to stop"

# Trap SIGINT to stop all services cleanly
cleanup() {
  log "Shutting down..."
  kill $API_PID 2>/dev/null || true
  [ -n "$DASHBOARD_PID" ] && kill "$DASHBOARD_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

wait $API_PID
