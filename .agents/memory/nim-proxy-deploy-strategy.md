---
name: NIM proxy patch deploy strategy
description: How to ship nim-proxy.py fixes without a full workspace image push
---

## The problem
The workspace image (mizi-workspace, 4.21GB) can't be reliably pushed from the Replit sandbox — docker push gets killed (exit -1 / signal) for large layers. Registry pulls also time out from this environment.

## The solution (no image push needed)
`vastai.ts` `buildOnStartScript()` generates the onstart script that runs when a Fly machine boots. It already embeds helper scripts (reload-model.sh) as inline heredocs in `nimLines`. 

To patch nim-proxy.py for ALL new NIM sessions without a new image:
- Add the full nim-proxy.py content as a `cat > /opt/nim-proxy.py << 'NIMPROXY_EOF'` block inside `nimLines`
- This runs BEFORE `/opt/onstart.sh` is called, so the patched file is in place when onstart.sh launches `python3 /opt/nim-proxy.py`
- Redeploy only the API server (fast, ~30s) — no workspace image push needed

**Why:** The generated onstart script is passed as `startCmd` to `fly.createMachine()` and runs on the machine before the image's own entrypoint logic.

## For running machines
Hot-patch via SSH: `fly ssh console -a mizi-workspace -s -C "tee /opt/nim-proxy.py << 'EOF' ... EOF"`
Then kill and restart the nim-proxy process.

## The double-v1 URL bug (fixed 2026-06-18)
`NIM_API_BASE` ends with `/v1`; FastAPI's `/{path:path}` captures path without leading `/` so it starts with `v1/`. Naïve join → `.../v1/v1/chat/completions` (404).
Fix: `effective_path = path[3:] if api_base.endswith("/v1") and path.startswith("v1/") else path`
