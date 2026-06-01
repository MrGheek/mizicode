#!/usr/bin/env bash
# set-fly-secrets.sh — Set all required Fly.io secrets for the mizi-api app.
#
# Usage:
#   bash artifacts/api-server/scripts/set-fly-secrets.sh
#
# Edit the REPLACE_ME values below before running.
# Secrets marked REQUIRED cause process.exit(1) at startup if missing in production.
# Secrets marked RECOMMENDED log a warning but the server still starts.
# Secrets marked OPTIONAL are only needed for specific features.
#
# One-time setup (run once on a fresh deploy; safe to re-run):
#   flyctl apps create mizi-workspace
#   fly postgres attach <pg-app-name> --app mizi-api   # sets DATABASE_URL automatically

set -euo pipefail

APP="${FLY_APP:-mizi-api}"
echo "Setting Fly secrets for app: $APP"
echo ""

# ── Core (REQUIRED — server exits on startup without these) ──────────────────

# PostgreSQL connection string.
# Set automatically by: fly postgres attach <pg-app> --app mizi-api
# If using an external Postgres, paste the full URL here.
fly secrets set --app "$APP" \
  DATABASE_URL="REPLACE_ME: postgres://user:password@host:5432/dbname"

# 64-hex-char key for encrypting provisioned connection strings at rest.
# Generate with: openssl rand -hex 32
fly secrets set --app "$APP" \
  MIZI_ENCRYPTION_KEY="REPLACE_ME: $(openssl rand -hex 32)"

# Token used to derive the GitHub OAuth token encryption key.
# Generate with: openssl rand -hex 32
# Missing = server crashes mid-OAuth-callback → user sees ?github_oauth=error
fly secrets set --app "$APP" \
  MIZI_MEM_TOKEN="REPLACE_ME: $(openssl rand -hex 32)"

# ── Fly workspace provisioning (REQUIRED for NIM sessions) ───────────────────

# Fly.io personal access token used by the API server to create/destroy
# workspace machines via the Fly Machines API.
# Generate with: fly tokens create deploy -x 999999h
# Missing = process.exit(1) at startup; 503 on /api/healthz
fly secrets set --app "$APP" \
  FLY_API_TOKEN="REPLACE_ME: $(fly tokens create deploy -x 999999h 2>/dev/null || echo 'run: fly tokens create deploy -x 999999h')"

# Name of the dedicated Fly app for workspace machines.
# Workspace machines must NOT live in the same app as mizi-api — using a
# dedicated app prevents cross-session load-balancer routing.
# One-time setup: flyctl apps create mizi-workspace
# Missing = process.exit(1) at startup; 503 on /api/healthz
fly secrets set --app "$APP" \
  FLY_WORKSPACE_APP_NAME="mizi-workspace"

# ── GitHub OAuth (REQUIRED for "Connect GitHub" to work) ─────────────────────

# OAuth App credentials from https://github.com/settings/developers
# Set the callback URL on your GitHub OAuth App to:
#   https://mizi-api.fly.dev/api/auth/github/callback
fly secrets set --app "$APP" \
  GITHUB_OAUTH_CLIENT_ID="REPLACE_ME"

fly secrets set --app "$APP" \
  GITHUB_OAUTH_CLIENT_SECRET="REPLACE_ME"

# Full URL of the dashboard (RECOMMENDED).
# Required so post-OAuth redirects land on the dashboard.
# Without it: token is stored but the dashboard never gets ?github_oauth=connected
fly secrets set --app "$APP" \
  DASHBOARD_URL="https://mizicode.fly.dev"

# ── AI providers (OPTIONAL — required for AI features) ───────────────────────

# NVIDIA NIM API key — required for NIM workspace session AI features.
# Obtain from: https://build.nvidia.com/
fly secrets set --app "$APP" \
  NVIDIA_NIM_API_KEY="REPLACE_ME: nvapi-..."

echo ""
echo "Done. Verify with:"
echo "  fly secrets list --app $APP"
echo "  curl https://mizi-api.fly.dev/api/healthz"
echo ""
echo "Post-setup checklist:"
echo "  1. flyctl apps create mizi-workspace       # if not already created"
echo "  2. fly postgres attach <pg-app> --app $APP # sets DATABASE_URL automatically"
echo "  3. fly deploy --app $APP                   # deploy the API server"
echo "  4. curl https://mizi-api.fly.dev/api/healthz  # should return {\"status\":\"ok\"}"
