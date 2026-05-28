---
name: Dockerfile Python build tools
description: Both Dockerfiles require Python+build-tools for better-sqlite3; API server uses Alpine (apk), dashboard uses Debian slim (apt-get).
---

## Rule
Both `artifacts/api-server/Dockerfile` (node:20-alpine) and `artifacts/dashboard/Dockerfile` (node:20-slim) must install Python + C++ build tools **before** `pnpm install --frozen-lockfile`, because `better-sqlite3` is a workspace dependency and node-gyp needs to compile it.

**Why:** `pnpm install --frozen-lockfile` installs all workspace packages including `better-sqlite3`'s native bindings. Without Python/make/g++, the build fails with "Could not find any Python installation to use".

**How to apply:**
- Alpine (api-server): `RUN apk add --no-cache python3 make g++`
- Debian slim (dashboard): `RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*`

Place these lines immediately after the `corepack prepare` line, before any COPY/install steps.
