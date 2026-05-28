#!/usr/bin/env bash
# install-local-deps.sh
#
# Run this once after extracting a Mizi-Local tarball to install
# Node.js runtime dependencies on the target host.
#
# Usage (from the extracted archive directory):
#   bash install-local-deps.sh
#
# Requirements:
#   - Node.js >= 20  (checked below)
#   - npm (bundled with Node.js)
#   - Internet access to npmjs.com (or a local registry mirror)
#
# After installation, start the server with:
#   bash start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[install] $*"; }

# ── Node.js version check ──────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[install] ERROR: Node.js is not installed."
  echo "  Install Node.js >= 20 from https://nodejs.org or via your package manager:"
  echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "    sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node)")
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[install] ERROR: Node.js >= 20 is required (found $NODE_VERSION)."
  exit 1
fi
log "Node.js $NODE_VERSION — OK"

# ── API server dependencies ────────────────────────────────────────────────────
# Package layout: artifacts/api-server/dist/ (matches mizi-local-start.sh paths)
API_DIR="$SCRIPT_DIR/artifacts/api-server/dist"

if [ ! -d "$API_DIR" ]; then
  echo "[install] ERROR: api-server not found at $API_DIR"
  echo "  Run this script from inside the extracted Mizi-Local archive."
  exit 1
fi

log "Installing API server production dependencies..."
cd "$API_DIR"

# Write a minimal package.json if none exists (for native module resolution)
if [ ! -f "package.json" ]; then
  cat > package.json <<'EOF'
{
  "name": "mizi-local-api",
  "version": "1.0.0",
  "type": "module",
  "private": true
}
EOF
fi

# Install only the native dependencies that esbuild cannot bundle
# better-sqlite3 is required for the SQLite local DB backend
npm install --save better-sqlite3@^12.10.0 --omit=dev --no-audit --no-fund

log "Dependencies installed."

# ── Dashboard static files check ──────────────────────────────────────────────
DASHBOARD_DIR="$SCRIPT_DIR/artifacts/dashboard/dist"
if [ -d "$DASHBOARD_DIR" ]; then
  log "Dashboard static files found at $DASHBOARD_DIR"
else
  log "WARNING: Dashboard not found. The web UI will not be available."
  log "  Start API and access the fallback chat at http://localhost:3737/api/local/chat"
fi

echo ""
log "=== Installation complete ==="
log "  Start Mizi-Local with: bash $SCRIPT_DIR/start.sh"
echo ""
