#!/usr/bin/env bash
# start-local.sh — Run MIZI Theia locally with optional NIM/Vast + Ollama
#
# Usage:
#   bash start-local.sh                          # Standalone (no MIZI API)
#   bash start-local.sh --nim                    # NIM chat + optional Ollama
#   bash start-local.sh --nim --no-ollama        # NIM only
#   bash start-local.sh --vast <ip>              # Vast.ai + Ollama
#   bash start-local.sh --api-base <url>         # With MIZI API server
#
# Requires: node >=18, Theia built at docker/mizi-theia/
set -euo pipefail

PORT="${PORT:-3000}"
ROOT_DIR="${ROOT_DIR:-$HOME/projects}"
THEIA_DIR="$(cd "$(dirname "$0")" && pwd)"
THEIA_CONFIG_DIR="${THEIA_CONFIG_DIR:-$HOME/.theia-mizi}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
NIM_API_BASE="${NIM_API_BASE:-https://integrate.api.nvidia.com/v1}"
SKIP_OLLAMA=false
USE_NIM=false
VAST_IP=""
MIZI_API_BASE=""

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --nim)        USE_NIM=true; shift ;;
    --no-ollama)  SKIP_OLLAMA=true; shift ;;
    --vast)       VAST_IP="$2"; shift 2 ;;
    --port)       PORT="$2"; shift 2 ;;
    --api-base)   MIZI_API_BASE="$2"; shift 2 ;;
    --root-dir)   ROOT_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash start-local.sh [--nim] [--no-ollama] [--vast <ip>] [--port <port>] [--api-base <url>] [--root-dir <dir>]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Logging ───────────────────────────────────────────────────────────────────
log() { echo "[mizi-theia] $*"; }

# ── Free port ──────────────────────────────────────────────────────────────────
if lsof -ti ":$PORT" &>/dev/null; then
  log "Port $PORT is in use — killing existing process..."
  lsof -ti ":$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# ── Configuration ─────────────────────────────────────────────────────────────
log "Port: $PORT"
log "Root dir: $ROOT_DIR"
if [ -n "$MIZI_API_BASE" ]; then
  log "MIZI API base: $MIZI_API_BASE"
else
  log "MIZI API base: (none — running standalone)"
fi

# ── Vast.ai mode ──────────────────────────────────────────────────────────────
if [ -n "$VAST_IP" ]; then
  USE_NIM=true
  if [ -z "${NIM_API_KEY:-}" ]; then
    log "ERROR: --vast requires NIM_API_KEY env var"
    exit 1
  fi
  NIM_API_BASE="http://$VAST_IP:8000/v1"
  if [ -z "$MIZI_API_BASE" ]; then
    MIZI_API_BASE="http://$VAST_IP:4000"
  fi
  log "Vast.ai mode: NIM at $NIM_API_BASE, MIZI API at $MIZI_API_BASE"
fi

# ── NIM check ─────────────────────────────────────────────────────────────────
if [ "$USE_NIM" = true ] && [ -z "${NIM_API_KEY:-}" ]; then
  log "ERROR: --nim requires NIM_API_KEY env var"
  log "  Set: export NIM_API_KEY=nvapi-..."
  exit 1
fi

# ── Ollama setup ──────────────────────────────────────────────────────────────
if [ "$SKIP_OLLAMA" = false ]; then
  if command -v ollama &>/dev/null; then
    if ! curl -sf "http://localhost:$OLLAMA_PORT/api/version" &>/dev/null; then
      log "Starting Ollama..."
      ollama serve &>/dev/null &
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
    if ! ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
      log "Pulling embedding model: nomic-embed-text (first run)..."
      ollama pull nomic-embed-text &>/dev/null || log "Warning: embedding model pull failed"
    fi
  else
    log "Ollama not found — embeddings will fall back to CPU"
  fi
fi

# ── Generate Theia settings ───────────────────────────────────────────────────
mkdir -p "$THEIA_CONFIG_DIR"
SETTINGS="$THEIA_CONFIG_DIR/settings.json"

cat > "$SETTINGS" << SETTINGSEOF
{
  "ai-core.enable": true,
  "ai-history.enable": true,
  "ai-code-completion.enable": $( [ "$SKIP_OLLAMA" = false ] && echo "true" || echo "false" )
}
SETTINGSEOF
log "Settings written: $SETTINGS"

# ── Launch Theia ──────────────────────────────────────────────────────────────
log "Starting MIZI Theia on port $PORT..."
log "  URL: http://localhost:$PORT"

THEIA_CONFIG_DIR="$THEIA_CONFIG_DIR" \
MIZI_API_BASE="$MIZI_API_BASE" \
NIM_API_KEY="${NIM_API_KEY:-}" \
NIM_API_BASE="${NIM_API_BASE:-}" \
node "$THEIA_DIR/src-gen/backend/server.js" \
  --port="$PORT" \
  --hostname=0.0.0.0 \
  --root-dir="$ROOT_DIR"
