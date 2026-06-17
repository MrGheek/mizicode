---
name: Wrangler 6PN nginx IPv6 proxy
description: wrangler/workerd binds only to 127.0.0.1; 6PN proxy needs nginx with dual-stack listen; must include listen [::]:PORT for IPv6.
---

## Rule
When proxying to wrangler/workerd (bolt.diy) via Fly 6PN, you need nginx as an intermediary with **both** IPv4 and IPv6 listen directives.

## Why
- `workerd` (wrangler) always binds to `127.0.0.1:<port>` — loopback only, no CLI flag to change this via `pnpm run start`.
- Fly 6PN resolves `<machineId>.vm.<app>.internal` to an **IPv6** address (`fdaa:…`).
- A plain `listen 8789;` in nginx only opens `0.0.0.0:8789` (IPv4). IPv6 connections to that port get ECONNREFUSED.
- You must add `listen [::]:8789;` alongside `listen 8789;` to accept 6PN IPv6 connections.

## How to apply
In every nginx server block intended for 6PN access, use two listen lines:
```nginx
server {
    listen 8789;
    listen [::]:8789;
    server_name _;
    location / {
        proxy_pass http://localhost:8788;
        ...
    }
}
```
Port 8789 is the no-auth internal proxy port. Port 8788 is where workerd actually listens (loopback only). Port 8789 is NOT a Fly internet service so it's only reachable via 6PN.

## Key deployment tag
The first workspace image with this fix: `registry.fly.io/mizi-workspace:deployment-01KVAJYHD6CM1CQHT53YJBG5GY`
Pinned in `artifacts/api-server/src/services/profiles.ts` → `dockerImageTag`.
