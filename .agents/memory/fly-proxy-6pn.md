---
name: Fly proxy subprocess vs 6PN direct
description: Why fly proxy subprocess fails from inside a Fly container, and the correct approach
---

# Rule
Never use `fly proxy` subprocess from inside a Fly container to reach other machines.
Use direct HTTP to `http://<machineId>.vm.<appName>.internal:<port>` instead.

**Why:**
`fly proxy` works by establishing a NEW WireGuard tunnel from wherever it's run to Fly's private network.
Inside a Fly container, the WireGuard interface (6PN) already exists. flyctl binds to the local port
immediately (so a TCP readiness poll passes), but when it tries to route actual HTTP traffic it
conflicts with or fails to traverse the existing WireGuard session. Every proxied request returns
ECONNREFUSED or ECONNRESET → http-proxy-middleware fires on.error → 502 "Workspace proxy unavailable".

The symptom was reproducible: ~10s after clicking "Open Coding Environment", always the same error,
machine confirmed "started" via the Fly Machines API.

**How to apply:**
In `fly.ts`, `getMachineProxyUrl(machineId, appName)` returns the direct 6PN URL.
`createProxyMiddleware({ target: url })` in sessions.ts uses it without any subprocess.
From inside a Fly app, `.internal` DNS names are resolved by Fly's internal DNS (fdaa::3).
No subprocess, no polling, no `fly proxy` install in the Dockerfile required.
