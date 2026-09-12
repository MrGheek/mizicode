# MIZI Launch Readiness

Last review: Aug 2026 (post v0.13.x).

This document tracks the launch-readiness posture of the MIZI coding
environment: what's covered, where the seams are, and the verifications
operators must run before opening the product to outside users.

---

## 1. API server boot posture

| Check                                                 | State |
| ----------------------------------------------------- | ----- |
| `PORT` required at startup (no silent default)        | ✅ index.ts:62-74 |
| Memory data dir validated before `app.listen()` (cloud) | ✅ index.ts:80-88 |
| Production secret guards fail fast on boot            | ✅ index.ts:98-141 (`MIZI_ENCRYPTION_KEY`, `MIZI_MEM_TOKEN`, `FLY_API_TOKEN`, `FLY_WORKSPACE_APP_NAME`) |
| Passive-recall backfill runs in the background        | ✅ index.ts:368-376, 419-429 |
| Claim sweeper + purger + eval scheduler armed at boot | ✅ index.ts:345-366 |
| Disk monitor armed                                    | ✅ index.ts:370-376 (`startMemoryDiskMonitor`) |
| Plan auto-advance + plan decompose                    | ✅ index.ts:378-390 |
| Ambient runner + safety subsystem started             | ✅ index.ts:405-415 |
| NIM catalog synced at boot, re-synced every 6h        | ✅ index.ts:392-403 |

### Why the passive-recall backfill matters

A past boot bug emitted:

> `Passive recall backfill failed (non-fatal): SqliteError: no such table: mem_items`

The bug: `runPassiveRecallBackfill` called into `memory-passive.ts`'s
`getDb()`, which opens the same SQLite file but only runs the
`mem_passive_*` migrations. The `mem_items` table is created by
`runGovernanceMigrations` inside `memory.ts`'s `getDb()` — and that one
hadn't been called yet on a brand-new install.

The fix is a single line: `runPassiveRecallBackfill` now calls memory.ts's
`getDb()` first to force governance migrations. Idempotent — `getDb()`
memoises the handle, so this is free on warm boots.

---

## 2. Authn / authz posture

All control-plane surfaces share the same Bearer token: `MIZI_MEM_TOKEN`.
In production the API server **refuses to boot** without it (index.ts:107-110),
so there is no "silently open" failure mode on a misconfigured deploy.

| Surface                                                | Production guard | Dev mode |
| ------------------------------------------------------ | ---------------- | -------- |
| `/api/memory/*`                                        | ✅ fails fast at boot if `MIZI_MEM_TOKEN` unset | warns and serves open |
| `/api/ambient/*`, `/api/safety/*`                      | ✅ fails fast at boot if `MIZI_MEM_TOKEN` unset | warns and serves open |
| `/api/sessions/:id/status` (instance callback)         | ✅ fails fast at boot (index.ts) **and** throws at import time (`sessions-common.ts:70-74`) | warns and serves open |
| `/api/dashboard/ambient/*`, `/api/dashboard/safety/*`  | Read-only mirror; no mutating routes registered | same |

### Operator checklist

- `MIZI_MEM_TOKEN` must be a high-entropy random string (≥ 32 bytes).
- Same value must be passed to every workspace machine as
  `MIZI_MEM_AUTH_TOKEN` — injected by the API server at machine creation
  (see `docker/README.md` env table).
- Rotating the token requires restarting the API server **and** any
  in-flight machines.

---

## 3. Coordination / blast-radius posture

The Team tab and lane coordination logic depend on two overlap signals:

1. **Path overlap** (`computeClaimOverlap`) — direct path collisions.
2. **Blast-radius overlap** (`estimateBlastRadiusOverlap`) — graph-adjacent
   files reached via the repo edges produced by the indexer.

Both live in `artifacts/api-server/src/services/lane-policy.ts`.

### State

| Endpoint | Path overlap | Blast radius |
| -------- | ------------ | ------------ |
| `GET /api/sessions/:id/conflicts`                                    | ✅ | ✅ (loads `sessionRepoContextTable.edgesJson`) |
| `POST /api/sessions/:id/lanes/:laneId/claim`                         | ✅ | ✅ (`estimateBlastRadiusOverlap` on graph edges) |

A soft-claim that doesn't directly collide with another lane's claims, but
does share a transitive dependency, surfaces a `warn` recommendation instead
of `no_conflict`. This matches the `/conflicts` endpoint's behaviour and
removes a class of "two lanes accidentally race on the same upstream" bugs.

---

## 4. Boot-phase failure classification

The cockpit renders a Boot Timeline. NIM (hosted-inference) sessions use a
condensed **3-phase** timeline (container → NIM proxy → bolt.diy ready);
legacy GPU sessions use the 7-phase timeline. Before structured failures were
introduced, generic `error` statuses collapsed onto the last-observed phase
with no actionable hint.

`docker/onstart.sh` now emits structured failures via `report_failure`:

| Cause                   | Phase mapped to | Trigger |
| ----------------------- | --------------- | ------- |
| `provisioning_failed`   | container       | top-level `ERR` trap during Phase 1 |
| `disk_full`             | weights         | onstart log contains "no space left on device", OR `df -P` reports any of `/workspace`, `/var/log`, `/tmp` with ≤1MB available |
| `skills_compile_failed` | skills          | `MIZI_ACTIVE_BUNDLE_B64` decode failure |
| `download_failed`       | weights         | `huggingface-cli download` retry exhaustion (GPU-backed sessions) |
| `download_stalled`      | weights         | size-progress watchdog: no new bytes in `MODEL_DIR` for `DOWNLOAD_STALL_TIMEOUT_SEC` (default 180s) (GPU-backed sessions) |
| `vllm_warmup_failed`    | llm             | vLLM /health does not return within 600s (GPU-backed sessions) |

> NIM (hosted-inference) sessions only reach `provisioning_failed`,
> `skills_compile_failed`, and `disk_full` — there is no model download or
> vLLM warmup. The `download_*` / `vllm_warmup_failed` causes apply to
> GPU-backed sessions (Vast.ai) that download weights and boot vLLM.

The API server's `INSTANCE_STATUS_MAP` (`sessions-common.ts:88-102`) maps each
cause to `status="error"` with a `boot_failure:<cause>` marker baked into
`statusMessage` via `buildFailureStatusMessage` (`sessions-common.ts:257-261`).
The dashboard's `parseBootFailure` (`boot-phases.ts:74-86`) extracts that
marker and the BootTimeline component renders a "Suggested next step" row
beneath the failed phase.

### What this gives operators

- A user whose session fails to provision sees:
  `"Container provisioning failed before services came up — destroy this session and retry on a different host."`
  instead of a red "Booting" badge with no explanation.
- Disk-full failures keep their existing "Destroy & Retry" CTA but now also
  fire when the structured cause arrives, not just when "no space left on
  device" appears literally in the log.

---

## 5. Bundled `claw` binary disambiguation

`docker/claw-code-src/claw-code-main/` is a vendor copy of upstream
`instructkr/claw-code` that contains both a Python tree (api/, commands/,
runtime/, tools/) and a Rust workspace (`rust/`).

**MIZI ships only the Rust binary.** The Dockerfile builds
`rusty-claude-cli` from `/opt/claw-code-src/rust` and exposes it as the
canonical `claw` CLI. The Python tree is included for upstream-compat
reasons but is not invoked at runtime. See
`docker/claw-code-src/README.md` — it documents the layout and points future
upgraders at the Rust workspace.

---

## 6. Test coverage delta

`artifacts/api-server/src/tests/launch-readiness.test.ts` covers:

- Passive-recall backfill on a fresh DB (regression for the boot bug).
- Coordination claim creation surfaces blast-radius overlap when paths are
  graph-adjacent but not directly overlapping.
- Instance-status callback accepts all six structured failure phases and
  persists the `boot_failure:<cause>` marker.
- Instance-status callback rejects unknown phases (400).
- Instance-status callback rejects unauthenticated requests (401).
- The structured-failure callback assertions exercise the realistic
  `{status, message}` payload shape that `docker/onstart.sh` actually sends,
  and verify both the `boot_failure:<cause>` marker AND the human message
  survive the persisted `statusMessage`. This is what the dashboard's
  `parseBootFailure` depends on.

The dashboard also has a vitest runner (`vitest run --config
vitest.config.ts`); `artifacts/dashboard/src/tests/` covers boot-phase and
repo-grouped-list rendering on the frontend side.

Run with:

```bash
pnpm --filter @workspace/api-server test
```

---

## 7. Pre-launch verification checklist

Run before opening to outside users:

- [ ] `pnpm --filter @workspace/api-server test` — all tests green.
- [ ] `pnpm --filter @workspace/api-server typecheck` — no errors.
- [ ] Boot the API server with `NODE_ENV=production` and **no**
      `MIZI_MEM_TOKEN` — confirm it refuses to start with a clear
      error mentioning the env var.
- [ ] Boot with `MIZI_MEM_TOKEN` set — confirm `/api/memory/*`,
      `/api/ambient/*`, `/api/safety/*`, `/api/sessions/:id/status` all
      return 401 without the bearer.
- [ ] Boot the API server fresh against an empty `MEM_DATA_DIR` and
      confirm the boot log no longer contains "no such table: mem_items".
- [ ] In a real session, simulate a structured failure callback:
      `curl -X POST /api/sessions/<id>/status -H "Authorization: Bearer $TOKEN" -d '{"status":"skills_compile_failed"}'`
      and confirm the cockpit shows the suggested-next-step row.
- [ ] Verify `MIZI_MEM_TOKEN` is also injected into Fly workspace machines as
      `MIZI_MEM_AUTH_TOKEN` so callbacks from the running machine authenticate.
- [ ] Smoke-test the Team tab: create two lanes, claim graph-adjacent files
      in each, confirm the second claim's response includes a non-zero
      `blastRadiusOverlap`.
- [ ] Confirm `claw --version` inside the running container reports the Rust
      binary's version, not the Python package metadata.
- [ ] Read `docker/claw-code-src/README.md` and confirm it matches the reality
      of the current Dockerfile.

---

## 8. Known seams (not regressions, but worth knowing)

- **Embeddings backfill is best-effort.** If no embedding provider is
  reachable — `NVIDIA_NIM_API_KEY` / `AI_INTEGRATIONS_OPENAI_*` unset and no
  local Hailo/Ollama backend — the pipeline falls back to lexical TF-IDF
  cosine (`memory-semantic.ts`). Recall quality is reduced but the system
  never crashes.
- **NIM sessions skip model download/warmup.** Hosted-inference sessions come
  up in seconds (container → NIM proxy → ready). The legacy `download_*` /
  `vllm_warmup_failed` causes only apply to old GPU-based sessions.
- **Theia and tools stay reachable on `provisioning_failed`.** This is
  intentional where possible — operators can SSH in and inspect
  `/var/log/onstart.log` without destroying the instance.
- **Callback failure phases are advisory.** Failure callbacks set
  `status="error"` but do not auto-destroy the workspace machine. The user
  (or operator) decides whether to retry.

---

## 9. Explicitly out of scope

The following launch-related items are **not** part of the current release
scope and are tracked separately. Listing them here so an operator reading
this doc knows where the seams are:

- **End-to-end ambient safety enforcement UX.** The token-gating and
  fail-fast posture for `/api/safety/*` and `/api/ambient/*` is covered
  (section 2), but the in-flow approval prompt that blocks agent execution
  mid-run is owned by the ambient runner work.
- **Passive recall affecting live agent replies with per-session toggle.**
  The boot-time backfill bug is fixed and regression-tested; the runtime
  "recall actually changes the next reply" loop and the per-session on/off
  control sit in the memory/recall product surface and have their own tests.
- **Dashboard E2E harness** (relaunch flow, command palette + shortcuts,
  recall round-trip). The dashboard now has a vitest runner and unit-level
  coverage for boot-phase classification and repo-grouped-list rendering, but
  full browser E2E flows are still a follow-up.
