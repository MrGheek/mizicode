---
name: Fly.io deploy method from Replit sandbox
description: How to deploy to Fly.io without hitting sandbox network timeouts
---

Direct `flyctl deploy` times out in Replit's sandbox because it waits for machines to become healthy over a long-lived connection.

**Working method:**
1. Run deploy in background with `nohup ... > /tmp/fly-deploy.log 2>&1 &` to build and push the image
2. Wait ~20s, check `/tmp/fly-deploy.log` to confirm image was pushed
3. Then run a second `flyctl deploy --image registry.fly.io/<app>:<tag> --strategy immediate` which completes fast (just updates machine configs, no rebuild)

**Dashboard deploy command:**
```
$HOME/.fly/bin/flyctl deploy \
  --config artifacts/dashboard/fly.toml \
  --dockerfile artifacts/dashboard/Dockerfile \
  --build-arg VITE_API_BASE_URL=https://mizi-api.fly.dev/ \
  > /tmp/fly-deploy.log 2>&1 &
```
Build context must be monorepo root (not artifacts/dashboard/) because Dockerfile copies pnpm-lock.yaml and lib/ from root.

**App names:** dashboard = `mizicode`, api = `mizi-api`
