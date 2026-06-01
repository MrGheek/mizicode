---
name: Fly.io deploy method from Replit sandbox
description: How to deploy to Fly.io without hitting sandbox network timeouts
---

Direct `flyctl deploy` times out in Replit's sandbox because the build (especially better-sqlite3 C++ compile) takes >2 minutes and the tool kills all processes at 120s.

**Working method (two-step):**
1. Use Python `subprocess.Popen` (NOT nohup/setsid — those get killed when the tool exits) to stream the build, waiting up to 110s. If it times out mid-build, Depot has already cached completed layers.
2. Re-run the same `flyctl deploy` command — cached layers skip the slow compile. When the log shows `image: registry.fly.io/<app>:<tag>`, the image is pushed.
3. Then run `flyctl deploy --app <app> --image registry.fly.io/<app>:<tag> --strategy immediate` — completes in ~15s (just runs migrations + swaps the machine).

**Python subprocess pattern:**
```python
import subprocess, os, time
env = os.environ.copy()
env['PATH'] = f"{os.path.expanduser('~')}/.fly/bin:" + env.get('PATH', '')
log = open('/tmp/fly-<app>-deploy.log', 'w')
p = subprocess.Popen(['flyctl', 'deploy', '--config', '...', '--strategy', 'immediate'],
    stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
    env=env, cwd='/home/runner/workspace')
# Poll up to 110s, check log for "image: registry.fly.io/..." to confirm push
```

**Why nohup/setsid fail:** Replit kills all processes in the cgroup when the tool command ends.
**Why Python Popen with start_new_session=True also fails:** FLY_API_TOKEN not inherited unless `env=os.environ.copy()` is passed explicitly.

**Root .dockerignore is required** at workspace root — artifact-level .dockerignore is ignored when build context is the monorepo root. Must exclude `node_modules`, `.git`, `.local`, `.agents`.

**Dockerfile layer order for caching:** Copy only package.json stubs for each workspace package → `pnpm install` → copy full source → build. This caches the slow better-sqlite3 compile until pnpm-lock.yaml changes.

**Alpine vs Debian:** `node:20-alpine` (musl) has no prebuilt better-sqlite3 binaries — always compiles (~3 min). `node:20-slim` (glibc/Debian) uses prebuilt binaries on subsequent runs, but first run after lockfile change still compiles.

**App names:** dashboard = `mizicode` (mizicode.fly.dev), api = `mizi-api` (mizi-api.fly.dev), workspace = `mizi-workspace`

**Dashboard deploy:**
```
flyctl deploy --config artifacts/dashboard/fly.toml \
  --dockerfile artifacts/dashboard/Dockerfile \
  --build-arg VITE_API_BASE_URL=https://mizi-api.fly.dev/ \
  --strategy immediate
```

**API deploy:**
```
flyctl deploy --config artifacts/api-server/fly.toml \
  --dockerfile artifacts/api-server/Dockerfile \
  --strategy immediate
```
Build context must be monorepo root for both (Dockerfiles copy pnpm-lock.yaml and lib/ from root).
