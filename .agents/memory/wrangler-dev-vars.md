---
name: Wrangler env vars require .dev.vars
description: wrangler pages dev reads env from .dev.vars not .env.local — must write both in onstart.sh
---

## Rule
When configuring bolt.diy's environment in `docker/onstart.sh`, always write both `.env.local` AND `.dev.vars` with the same `KEY=VALUE` pairs.

**Why:** `.env.local` is Vite's env file — only used when bolt.diy runs in dev mode (`pnpm run dev`). `wrangler pages dev` (production mode, `pnpm run start`) reads env bindings from `.dev.vars`, not `.env.local`. If only `.env.local` is written, the wrangler worker's `env.OPENAI_LIKE_API_BASE_URL` is undefined → `/api/llmcall` returns 500, `/api/mcp-update-config` returns 502.

**How to apply:** Any time onstart.sh sets bolt.diy LLM/API config, duplicate the heredoc:
```sh
cat > .env.local << EOF
OPENAI_LIKE_API_BASE_URL=http://localhost:${VLLM_PORT}/v1
OPENAI_LIKE_API_KEY=not-needed
EOF
cat > .dev.vars << EOF
OPENAI_LIKE_API_BASE_URL=http://localhost:${VLLM_PORT}/v1
OPENAI_LIKE_API_KEY=not-needed
EOF
```

After any onstart.sh change, rebuild the workspace image (`flyctl deploy --app mizi-workspace --dockerfile docker/Dockerfile.nim-workspace --strategy immediate --no-public-ips`) and update the `dockerImageTag` in `artifacts/api-server/src/services/profiles.ts` for the `nim-workspace` profile, then rebuild + redeploy the API server.
