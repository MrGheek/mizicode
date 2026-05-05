# FLOATR Launch Readiness

Last review: Task #233.

This document tracks the launch-readiness posture of the FLOATR coding
environment: what's covered, where the seams are, and the verifications
operators must run before opening the product to outside users.

---

## 1. API server boot posture

| Check                                                 | State |
| ----------------------------------------------------- | ----- |
| `PORT` required at startup (no silent default)        | ✅ index.ts:62-72 |
| Memory data dir validated before `app.listen()`       | ✅ index.ts:78-83 |
| Passive-recall backfill runs in the background        | ✅ index.ts:152-161 |
| Backfill no longer crashes on a fresh DB              | ✅ memory.ts:`runPassiveRecallBackfill` calls `getDb()` first |
| Claim sweeper + purger + eval scheduler armed at boot | ✅ index.ts:135-138 |
| Disk monitor armed                                    | ✅ index.ts:138 (`startMemoryDiskMonitor`) |

### Why the passive-recall fix matters

Before Task #233, the boot log emitted:

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

All control-plane surfaces share the same Bearer token: `OMNIQL_MEM_TOKEN`.

| Surface                                                | Production guard | Dev mode |
| ------------------------------------------------------ | ---------------- | -------- |
| `/api/memory/*`                                        | ✅ throws if unset (`memory.ts:73`) | warns and serves open |
| `/api/ambient/*`, `/api/safety/*`                      | ✅ throws if unset (`ambient.ts:48`) | warns and serves open |
| `/api/sessions/:id/status` (instance callback)         | ✅ throws if unset (`sessions.ts:181`) — **fixed in #233** | warns and serves open |
| `/api/dashboard/ambient/*`, `/api/dashboard/safety/*`  | Read-only mirror; no mutating routes registered | same |

Before Task #233 the instance-status callback was the one hole: a
production deploy without `OMNIQL_MEM_TOKEN` would silently accept any
internet host POSTing arbitrary status transitions for any session id.
Now all three token-gated routes fail fast on boot if the env var is
missing in production.

### Operator checklist

- `OMNIQL_MEM_TOKEN` must be a high-entropy random string (≥ 32 bytes).
- Same value must be passed to every Vast.ai instance as
  `OMNIQL_MEM_AUTH_TOKEN` — see `sessions.ts` instance launch path.
- Rotating the token requires restarting the API server **and** any
  in-flight instances (they cache it in `/etc/environment`).

---

## 3. Coordination / blast-radius posture

The Team tab and lane coordination logic depend on two overlap signals:

1. **Path overlap** (`computeClaimOverlap`) — direct path collisions.
2. **Blast-radius overlap** (`estimateBlastRadiusOverlap`) — graph-adjacent
   files reached via the repo edges produced by the indexer.

### State

| Endpoint | Path overlap | Blast radius |
| -------- | ------------ | ------------ |
| `GET /api/sessions/:id/conflicts`                                    | ✅ | ✅ (loads `sessionRepoContextTable.edgesJson`) |
| `POST /api/sessions/:id/lanes/:laneId/claim`                         | ✅ | ✅ — **fixed in #233** (was hardcoded `0`) |

The claim-time fix means a soft-claim that doesn't directly collide with
another lane's claims, but does share a transitive dependency, now
surfaces a `warn` recommendation instead of `no_conflict`. This matches
the `/conflicts` endpoint's behaviour and removes a class of
"two lanes accidentally race on the same upstream" bugs.

---

## 4. Boot-phase failure classification

The session cockpit renders a 7-step Boot Timeline. Before Task #233 it
only knew about success transitions and a single literal sentinel
(`no space left on device`). Generic `error` statuses collapsed onto
the last-observed phase with no actionable hint.

### After #233

`docker/onstart.sh` now emits structured failures via `report_failure`:

| Cause                   | Phase mapped to | Trigger |
| ----------------------- | --------------- | ------- |
| `provisioning_failed`   | container       | top-level `ERR` trap during Phase 1 |
| `disk_full`             | weights         | onstart log contains "no space left on device", OR `df -P` reports any of `/workspace`, `/var/log`, `/tmp` with ≤1MB available |
| `skills_compile_failed` | skills          | `FLOATR_ACTIVE_BUNDLE_B64` decode failure |
| `download_failed`       | weights         | `huggingface-cli download` retry exhaustion (non-stall errors) |
| `download_stalled`      | weights         | size-progress watchdog: no new bytes in `MODEL_DIR` for `DOWNLOAD_STALL_TIMEOUT_SEC` (default 180s) |
| `vllm_warmup_failed`    | llm             | vLLM /health does not return within 600s |

The API server's `INSTANCE_STATUS_MAP` (`sessions.ts`) maps each cause
to `status="error"` with a `boot_failure:<cause>` marker baked into
`statusMessage`. The dashboard's `parseBootFailure` (`boot-phases.ts`)
extracts that marker and the BootTimeline component renders a
"Suggested next step" row beneath the failed phase.

### What this gives operators

- A user whose vLLM warmup times out sees:
  `"vLLM did not come online within the warmup window — VRAM may be insufficient for this profile. Try a smaller quant or larger GPU profile."`
  instead of a red "Booting" badge with no explanation.
- Disk-full failures keep their existing "Destroy & Retry" CTA but now
  also fire when the structured cause arrives, not just when "no space
  left on device" appears literally in the log.

---

## 5. Bundled `claw` binary disambiguation

`docker/claw-code-src/claw-code-main/` is a vendor copy of upstream
`instructkr/claw-code` that contains both a Python tree (api/, commands/,
runtime/, tools/) and a Rust workspace (`rust/`).

**FLOATR ships only the Rust binary.** The Dockerfile builds
`rusty-claude-cli` from `/opt/claw-code-src/rust` and exposes it as the
canonical `claw` CLI. The Python tree is included for upstream-compat
reasons but is not invoked at runtime.

This was previously a footgun for new contributors: it looked like there
were two competing implementations and no documentation said which one
mattered. Task #233 adds `docker/claw-code-src/README.md` clarifying
the layout and pointing future upgraders at the Rust workspace.

---

## 6. Test coverage delta

New tests added in Task #233:

- `artifacts/api-server/src/tests/launch-readiness.test.ts`:
  - Passive-recall backfill on a fresh DB (regression for the boot bug).
  - Coordination claim creation surfaces blast-radius overlap when
    paths are graph-adjacent but not directly overlapping.
  - Instance-status callback accepts all six structured failure phases
    and persists the `boot_failure:<cause>` marker.
  - Instance-status callback rejects unknown phases (400).
  - Instance-status callback rejects unauthenticated requests (401).
  - The structured-failure callback assertions exercise the realistic
    `{status, message}` payload shape that `docker/onstart.sh` actually
    sends, and verify both the `boot_failure:<cause>` marker AND the
    human message survive the persisted `statusMessage`. This is what
    the dashboard's `parseBootFailure` depends on.

`artifacts/dashboard` does not have a vitest runner configured, so the
dashboard-side `parseBootFailure` / `inferBootPhase` rendering is
covered indirectly through the API server's structured-failure tests
plus manual visual inspection. Wiring vitest into the dashboard is
tracked as a follow-up.

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
      `OMNIQL_MEM_TOKEN` — confirm it refuses to start with a clear
      error mentioning the env var.
- [ ] Boot with `OMNIQL_MEM_TOKEN` set — confirm `/api/memory/*`,
      `/api/ambient/*`, `/api/safety/*`, `/api/sessions/:id/status` all
      return 401 without the bearer.
- [ ] Boot the API server fresh against an empty `MEM_DATA_DIR` and
      confirm the boot log no longer contains "no such table: mem_items".
- [ ] In a real session, simulate the structured failure callbacks:
      `curl -X POST /api/sessions/<id>/status -H "Authorization: Bearer $TOKEN" -d '{"status":"vllm_warmup_failed"}'`
      and confirm the cockpit shows the suggested-next-step row.
- [ ] Verify `OMNIQL_MEM_TOKEN` is also exported into the Vast.ai
      onstart environment as `OMNIQL_MEM_AUTH_TOKEN` so callbacks
      from the running instance authenticate.
- [ ] Smoke-test the Team tab: create two lanes, claim graph-adjacent
      files in each, confirm the second claim's response includes a
      non-zero `blastRadiusOverlap`.
- [ ] Confirm `claw --version` inside the running container reports the
      Rust binary's version, not the Python package metadata.
- [ ] Read `docker/claw-code-src/README.md` and confirm it matches the
      reality of the current Dockerfile.

---

## 8. Known seams (not regressions, but worth knowing)

- **Embeddings backfill is best-effort.** If `OPENAI_BASE_URL` is unset
  the pipeline falls back to lexical TF-IDF cosine; recall quality is
  reduced but the system never crashes.
- **vLLM warmup budget is 600s.** Hosts with cold model caches and slow
  disks can exceed this. The `vllm_warmup_failed` cause now surfaces
  this clearly instead of the session sitting at "starting" forever.
- **SSH and code-server stay reachable on `vllm_warmup_failed`.** This
  is intentional — operators can SSH in and inspect
  `/var/log/vllm-server.log` without destroying the instance.
- **`sessions.ts` callback failure phases are advisory.** Failure
  callbacks set `status="error"` but do not auto-destroy the Vast.ai
  instance. The user (or operator) decides whether to retry.

---

## 9. Explicitly out of scope for Task #233

The following launch-related items were **not** part of Task #233's
assigned scope and are tracked separately. Listing them here so an
operator reading this doc knows where the seams are:

- **End-to-end ambient safety enforcement UX.** The token-gating and
  fail-fast posture for `/api/safety/*` and `/api/ambient/*` is
  covered (section 2), but the in-flow approval prompt that blocks
  agent execution mid-run is owned by the ambient runner work.
- **Passive recall affecting live agent replies with per-session
  toggle.** This task fixed the boot-time backfill bug and added a
  fresh-DB regression test; the runtime "recall actually changes the
  next reply" loop and the per-session on/off control sit in the
  memory/recall product surface and have their own tests.
- **Dashboard E2E test harness** (relaunch flow, command palette +
  shortcuts, recall round-trip). `artifacts/dashboard` has no test
  runner configured and wiring one in is a separate task — see the
  follow-up. Today the boot-phase classifier is exercised through
  the API server's structured-failure tests instead.
- **Pre-existing typecheck debt** in `dashboard` and `api-server`
  (missing `queryKey`, stale `Session.ownerToken`/`swarmWorkerCap`,
  `benchmarkCallout` not in profiles schema, `claimPurgeLogsTable`
  not re-exported from `@workspace/db`). None touch the files
  changed by #233 and are tracked as a separate cleanup follow-up.
