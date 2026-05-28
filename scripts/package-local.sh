#!/usr/bin/env bash
# package-local.sh — Multi-platform release packaging for Mizi-Local
# Produces: mizi-local-<os>-<arch>.tar.gz for all supported targets
# Usage: bash scripts/package-local.sh [--version v1.0.0]
set -euo pipefail

VERSION="${VERSION:-$(node -e "console.log(require('./package.json').version || '1.0.0')" 2>/dev/null || echo "1.0.0")}"
DIST_DIR="dist-local"
PLATFORMS=("linux-arm64" "linux-x64" "darwin-arm64" "darwin-x64")

while [[ $# -gt 0 ]]; do
  case $1 in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "[package-local] Version: $VERSION"
echo "[package-local] Building local distribution..."

# Build the local distribution.
# CI=true tells vite.config.ts to skip the PORT/BASE_PATH env-var guards that
# are only needed in the live dev server; local builds use a fixed base path.
CI=true MIZI_DISTRIBUTION=local pnpm build:local

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

for PLATFORM in "${PLATFORMS[@]}"; do
  ARCHIVE_NAME="mizi-local-$PLATFORM-$VERSION"
  ARCHIVE_DIR="$DIST_DIR/$ARCHIVE_NAME"

  echo "[package-local] Packaging $PLATFORM..."

  mkdir -p "$ARCHIVE_DIR"

  # Core application files — mirrored into artifacts/<name>/dist/ so that
  # the shipped start.sh (which uses $SCRIPT_DIR/artifacts/...) finds them.
  mkdir -p "$ARCHIVE_DIR/artifacts/api-server"
  cp -r artifacts/api-server/dist "$ARCHIVE_DIR/artifacts/api-server/dist"
  mkdir -p "$ARCHIVE_DIR/artifacts/dashboard"
  cp -r artifacts/dashboard/dist  "$ARCHIVE_DIR/artifacts/dashboard/dist" 2>/dev/null || true
  # serve.mjs is the static file server used by service units and start.sh
  cp artifacts/dashboard/serve.mjs "$ARCHIVE_DIR/artifacts/dashboard/serve.mjs" 2>/dev/null || true

  # ACP runner shim — required for local HuggingClaw task dispatch
  mkdir -p "$ARCHIVE_DIR/local"
  cp -r local/. "$ARCHIVE_DIR/local/" 2>/dev/null || true

  # Local infrastructure
  cp -r local/workspace-templates "$ARCHIVE_DIR/workspace-templates" 2>/dev/null || true
  cp -r local/service-files       "$ARCHIVE_DIR/service-files"
  cp    mizi-local-start.sh        "$ARCHIVE_DIR/start.sh"
  chmod +x "$ARCHIVE_DIR/start.sh"

  # Dependency installer — required for native modules (better-sqlite3)
  cp scripts/install-local-deps.sh "$ARCHIVE_DIR/install.sh"
  chmod +x "$ARCHIVE_DIR/install.sh"

  # Config template
  cp config.env.template "$ARCHIVE_DIR/config.env.template"

  # Documentation
  cp CHANGELOG.local.md "$ARCHIVE_DIR/CHANGELOG.md" 2>/dev/null || true
  cp README.md           "$ARCHIVE_DIR/README.md"    2>/dev/null || true

  # Platform-specific marker
  echo "$PLATFORM" > "$ARCHIVE_DIR/.platform"
  echo "$VERSION"  > "$ARCHIVE_DIR/.version"

  # Create tarball — use a fixed name so installers can reference a stable URL.
  # A .version file inside the archive records the exact build version.
  TARBALL="$DIST_DIR/mizi-local-$PLATFORM.tar.gz"
  tar -czf "$TARBALL" -C "$DIST_DIR" "$ARCHIVE_NAME"
  rm -rf "$ARCHIVE_DIR"

  SIZE=$(du -sh "$TARBALL" | cut -f1)
  echo "[package-local] Created: $TARBALL ($SIZE)"
done

echo ""
echo "[package-local] Release artifacts:"
ls -lh "$DIST_DIR"/*.tar.gz
echo ""
echo "[package-local] Done. Upload tarballs to GitHub Releases."
