---
name: Wrangler port and Vite prebuild OOM
description: wrangler pages dev ignores PORT env var (always 8788); Vite dev server respects PORT; Depot builder OOMs during Vite chunk-rendering at ~1530MB
---

## Wrangler port behavior

`wrangler pages dev` always binds to port **8788** regardless of the `PORT` environment variable. Setting `PORT=5173 pnpm run start` does nothing — wrangler ignores it.

**Why:** Wrangler has its own port defaulting logic that bypasses the conventional `PORT` env var.

**How to apply:** nginx `proxy_pass` and any readiness-check curl loops must target `:8788` when the workspace runs in production mode (wrangler). Do NOT use `PORT=XXXX pnpm run start` to change the wrangler port — use `--port XXXX` flag directly in the wrangler command, or just leave it at 8788 and make everything else match.

## Vite dev server port behavior

`pnpm run dev` (Vite) **does** respect the `PORT` env var. Set `PORT=8788 pnpm run dev` to make the dev-mode fallback bind to the same port as the production wrangler server, keeping nginx and gate logic consistent across modes.

## Depot builder OOM during Vite prebuild

The Depot remote builder (used by `flyctl deploy --build-only`) OOMs during bolt.diy's Vite chunk-rendering phase:
- At `--max-old-space-size=4096`: SIGKILL (exit 137) — cgroup memory limit exceeded
- At `--max-old-space-size=1536`: V8 heap OOM (exit 134) — heap limit too tight
- At `--max-old-space-size=3072`: build **succeeds** (~78s for the Vite step)

**Why:** The Depot builder container has a memory ceiling that the full Vite + Rollup chunk render can push past with large heap limits; 3072MB appears to be the sweet spot.

**How to apply:** Keep `NODE_OPTIONS="--max-old-space-size=3072"` in the Dockerfile prebuild step. Also make the step non-fatal (`|| echo "[WARN]..."`) so images can still be built if the builder is ever lower-memory — onstart.sh falls back to dev mode (Vite at PORT=8788) which is slower on first load (~2-4 min) but fully functional.

## Workspace image build command

All layers are cached by Depot after the first successful run. Use:
```bash
flyctl deploy \
  --config docker/fly.workspace.toml \
  --dockerfile /home/runner/workspace/docker/Dockerfile.nim-workspace \
  --build-only \
  --image-label latest
```
(absolute path for `--dockerfile` required — relative path gets prefixed with the config file's directory, causing "file not found")

Use `--image-label latest` on the final push so `registry.fly.io/mizi-workspace:latest` is updated (the tag that `profiles.ts` references for new session machines).
