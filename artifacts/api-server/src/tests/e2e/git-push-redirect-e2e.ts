#!/usr/bin/env -S npx tsx
/**
 * E2E verification: git push → mizi/session-{id} inside a real Vast.ai container
 * Task #265
 *
 * This script provisions a live Vast.ai container, waits for it to boot, SSHes
 * in, and verifies all four task acceptance criteria using REAL git and GitHub:
 *
 *   1. GITHUB_TOKEN is exported in the container environment.
 *   2. /usr/local/bin/git exists and is executable.
 *   3. Running `git push origin main` from inside the container redirects the
 *      push to mizi/session-{id} on GitHub (verified via GitHub API).
 *   4. Non-push commands pass through to the real /usr/bin/git unchanged.
 *
 * No git stub is used — the real /usr/bin/git binary executes the push so that
 * credential failures, URL substitution issues, and remote branch creation are
 * all exercised exactly as they would be for a real user.
 *
 * Usage:
 *   VASTAI_API_KEY=vai-xxx \
 *   GITHUB_TOKEN=ghp_xxx \
 *   GITHUB_REPO=owner/repo \
 *     pnpm tsx src/tests/e2e/git-push-redirect-e2e.ts
 *
 * Required env vars:
 *   VASTAI_API_KEY  — Vast.ai API key
 *   GITHUB_TOKEN    — GitHub PAT with `repo` scope (used for push + branch verification)
 *   GITHUB_REPO     — Repository to push to, in `owner/repo` form.
 *                     The repo must exist. The test creates and deletes the branch
 *                     mizi/session-{E2E_SESSION_ID} — no other branches are touched.
 *
 * Optional env vars:
 *   E2E_SESSION_ID   — integer used as the mock session ID (default: 9999)
 *   E2E_BOOT_TIMEOUT — seconds to wait for container to become SSH-ready (default: 300)
 *
 * The script always destroys the Vast.ai instance and deletes the test branch on exit.
 */

import { execSync, spawnSync } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import { buildOnStartScript, searchOffers, createInstance, getInstance, destroyInstance } from "../../services/vastai.js";

// ─── config ──────────────────────────────────────────────────────────────────

const VASTAI_API_KEY  = process.env["VASTAI_API_KEY"];
const GITHUB_TOKEN    = process.env["GITHUB_TOKEN"];
const GITHUB_REPO     = process.env["GITHUB_REPO"];       // e.g. "acme/my-repo"
const SESSION_ID      = parseInt(process.env["E2E_SESSION_ID"] ?? "9999", 10);
const BOOT_TIMEOUT_S  = parseInt(process.env["E2E_BOOT_TIMEOUT"] ?? "300", 10);
const SESSION_BRANCH  = `mizi/session-${SESSION_ID}`;

// ─── skip guard ──────────────────────────────────────────────────────────────

if (!VASTAI_API_KEY || !GITHUB_TOKEN || !GITHUB_REPO) {
  console.log(
    "[SKIP] E2E test requires VASTAI_API_KEY, GITHUB_TOKEN, and GITHUB_REPO to be set.\n" +
    "\n" +
    "       GITHUB_TOKEN must be a PAT with 'repo' scope. GITHUB_REPO must be an\n" +
    "       existing repository in 'owner/repo' form. The test creates and immediately\n" +
    "       deletes the branch mizi/session-{E2E_SESSION_ID} — no other data is modified.\n" +
    "\n" +
    "       Example:\n" +
    "         VASTAI_API_KEY=vai-xxx \\\n" +
    "         GITHUB_TOKEN=ghp_xxx \\\n" +
    "         GITHUB_REPO=acme/mizi-e2e \\\n" +
    "           pnpm tsx src/tests/e2e/git-push-redirect-e2e.ts",
  );
  process.exit(0);
}

const [GITHUB_OWNER, GITHUB_REPONAME] = GITHUB_REPO.split("/");

// ─── ephemeral SSH key ────────────────────────────────────────────────────────

const sshDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizi-e2e-ssh-"));
const keyPath = path.join(sshDir, "e2e_ed25519");

function generateSshKey(): string {
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "mizi-e2e-verify"`, {
    stdio: "pipe",
  });
  return fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
}

// ─── onstart builder ─────────────────────────────────────────────────────────

/**
 * Build the E2E onstart script.
 *
 * Uses buildOnStartScript() to produce the real git wrapper (GITHUB_TOKEN,
 * git-config credential substitution, /usr/local/bin/git wrapper). Then appends:
 *   - SSH authorized_keys setup (so we can SSH in to run verification).
 *   - A real `git clone` of GITHUB_REPO into /tmp/test-repo (using the PAT).
 *   - A sentinel file + sleep so the container stays up for SSH verification.
 *
 * /usr/bin/git is NOT replaced — the real git binary executes the push.
 */
function buildE2eOnstart(sshPubKey: string): string {
  // Generate the full standard onstart script.
  const fullOnstart = buildOnStartScript({
    modelRepo:       "test/model",
    modelQuant:      "Q4_K_M",
    servedModelName: "test",
    llamaCtxSize:    1024,
    llamaBatchSize:  1,
    llamaExtraArgs:  "",
    githubToken:     GITHUB_TOKEN!,
    sessionId:       SESSION_ID,
  });

  // Extract the git-wrapper section: from `export GITHUB_TOKEN=` through
  // `chmod +x /usr/local/bin/git`.
  const wrapperStart = fullOnstart.indexOf(`export GITHUB_TOKEN="`);
  const wrapperEnd   = fullOnstart.indexOf("chmod +x /usr/local/bin/git");
  if (wrapperStart === -1 || wrapperEnd === -1) {
    throw new Error("Could not locate git wrapper section in generated onstart script");
  }
  const gitWrapperSection = fullOnstart.slice(
    wrapperStart,
    wrapperEnd + "chmod +x /usr/local/bin/git".length,
  );

  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    "# ── 1. Git credential config + wrapper installation ────────────────────",
    gitWrapperSection,
    "",
    "# ── 2. Inject ephemeral SSH public key ──────────────────────────────────",
    "mkdir -p /root/.ssh",
    `echo "${sshPubKey}" >> /root/.ssh/authorized_keys`,
    "chmod 700 /root/.ssh",
    "chmod 600 /root/.ssh/authorized_keys",
    "",
    "# ── 3. Clone the test repo using the PAT-authenticated HTTPS URL ─────────",
    // git config url.insteadOf is already set by the wrapper section above, so
    // this plain https:// clone will be rewritten to use the PAT automatically.
    `git clone https://github.com/${GITHUB_REPO}.git /tmp/test-repo`,
    "cd /tmp/test-repo",
    `git config user.email "e2e@mizi.test"`,
    `git config user.name "MIZI E2E"`,
    // Ensure a `main` branch exists with at least one commit so that
    // `git push origin main` (the command the wrapper intercepts) always works
    // regardless of the test repo's default branch name or empty state.
    // Steps:
    //  1. If `main` already exists locally (remote had main), we're done.
    //  2. Otherwise, create it from the current HEAD (or as an orphan commit).
    "if ! git show-ref --verify --quiet refs/heads/main; then",
    "  git checkout -b main 2>/dev/null || true",
    "fi",
    // If there are still no commits (completely empty repo), create one.
    "git log --oneline -1 2>/dev/null || git commit --allow-empty -m 'mizi-e2e-init'",
    // Ensure main branch is checked out for the push.
    "git checkout main 2>/dev/null || true",
    "",
    "# ── 4. Signal readiness ──────────────────────────────────────────────────",
    "touch /tmp/mizi-e2e-ready",
    "",
    "# Keep the container alive so we can SSH in for verification.",
    "sleep infinity",
  ].join("\n");
}

// ─── SSH helper ───────────────────────────────────────────────────────────────

function sshRun(host: string, port: number, cmd: string): string {
  const result = spawnSync(
    "ssh",
    [
      "-i", keyPath,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=10",
      "-p", String(port),
      `root@${host}`,
      cmd,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`SSH command failed (exit ${result.status}):\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function waitForSsh(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      sshRun(host, port, "echo ready");
      return;
    } catch {
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
  throw new Error(`SSH not reachable on ${host}:${port} after ${timeoutMs / 1000}s`);
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

async function githubApi(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const url = `https://api.github.com${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** Returns true if the branch exists on GitHub. */
async function branchExists(branch: string): Promise<boolean> {
  const encoded = encodeURIComponent(branch);
  const r = await githubApi("GET", `/repos/${GITHUB_OWNER}/${GITHUB_REPONAME}/branches/${encoded}`);
  return r.status === 200;
}

/** Delete a branch from GitHub (ignores 404). */
async function deleteBranch(branch: string): Promise<void> {
  const encoded = encodeURIComponent(branch);
  await githubApi(
    "DELETE",
    `/repos/${GITHUB_OWNER}/${GITHUB_REPONAME}/git/refs/heads/${encoded}`,
  );
}

// ─── poll instance ────────────────────────────────────────────────────────────

async function pollUntilRunning(
  instanceId: number,
  timeoutMs: number,
): Promise<{ host: string; sshPort: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inst = await getInstance(instanceId);
    const status = inst.actual_status;
    console.log(`  [poll] status=${status ?? "unknown"}`);
    if (status === "running" && inst.public_ipaddr) {
      const ports = inst.ports ?? {};
      const mapping = ports["22/tcp"];
      const sshPort = mapping?.[0]?.HostPort ? parseInt(mapping[0].HostPort, 10) : 22;
      return { host: inst.public_ipaddr, sshPort };
    }
    if (status === "exited" || status === "failed") {
      throw new Error(`Instance entered terminal state: ${status} — ${inst.status_msg ?? ""}`);
    }
    await new Promise(r => setTimeout(r, 10_000));
  }
  throw new Error(`Instance still not running after ${timeoutMs / 1000}s`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

let instanceId: number | null = null;
let testBranchCreated = false;

async function main() {
  const results: Array<{ name: string; pass: boolean; detail: string }> = [];

  function assert(name: string, condition: boolean, detail: string) {
    results.push({ name, pass: condition, detail });
    const icon = condition ? "✓" : "✗";
    console.log(`  ${icon} ${name}`);
    if (!condition || process.env["E2E_VERBOSE"]) console.log(`    ${detail}`);
  }

  try {
    // ── 1. Generate ephemeral SSH key ─────────────────────────────────────
    console.log("\n[1/8] Generating ephemeral SSH key pair…");
    const sshPubKey = generateSshKey();

    // ── 2. Pre-flight: verify GitHub token has push access ────────────────
    console.log("\n[2/8] Pre-flight: verifying GitHub PAT has repo access…");
    const meResp = await githubApi("GET", "/user");
    if (!meResp.ok) {
      throw new Error(`GitHub token is invalid or lacks API access (HTTP ${meResp.status})`);
    }
    const repoResp = await githubApi("GET", `/repos/${GITHUB_OWNER}/${GITHUB_REPONAME}`);
    if (!repoResp.ok) {
      throw new Error(
        `Cannot access ${GITHUB_REPO} (HTTP ${repoResp.status}) — ` +
        "check that GITHUB_TOKEN has repo scope and the repo exists",
      );
    }
    const repoPush = (repoResp.json as Record<string, unknown>)?.["permissions"];
    console.log(
      `  Repo access OK, permissions: ${JSON.stringify(repoPush ?? "unknown")}`,
    );

    // ── 3. Build E2E onstart ──────────────────────────────────────────────
    console.log("\n[3/8] Building E2E onstart script…");
    const onstart = buildE2eOnstart(sshPubKey);

    // ── 4. Find cheapest offer and provision instance ─────────────────────
    console.log("\n[4/8] Searching for cheapest Vast.ai offer…");
    const offers = await searchOffers({ disk_space: 20, limit: 5, order: "dph_total" });
    if (offers.length === 0) throw new Error("No rentable offers on Vast.ai");
    const offer = offers[0]!;
    console.log(
      `  Offer #${offer.id}: ${offer.gpu_name ?? "CPU"} @ ` +
      `$${offer.dph_total?.toFixed(4) ?? "?"}/hr`,
    );

    console.log("\n[5/8] Provisioning instance…");
    const created = await createInstance({
      offerId: offer.id,
      image:   "ubuntu:22.04",
      onstart,
      disk:    20,
    });
    instanceId = created.new_contract ?? null;
    if (!instanceId) throw new Error("createInstance() returned no contract ID");
    console.log(`  Instance ID: ${instanceId}`);

    // ── 5. Wait for running + SSH ─────────────────────────────────────────
    console.log(`\n[6/8] Waiting up to ${BOOT_TIMEOUT_S}s for instance to start…`);
    const { host, sshPort } = await pollUntilRunning(instanceId, BOOT_TIMEOUT_S * 1000);
    console.log(`  Running at ${host}:${sshPort}`);

    console.log("  Waiting for SSH…");
    await waitForSsh(host, sshPort, 120_000);

    console.log("  Waiting for onstart sentinel (/tmp/mizi-e2e-ready)…");
    const sentinelDeadline = Date.now() + 180_000;
    while (Date.now() < sentinelDeadline) {
      try {
        const r = sshRun(host, sshPort, "test -f /tmp/mizi-e2e-ready && echo yes || echo no");
        if (r === "yes") break;
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 5_000));
    }

    // ── 6. Verify acceptance criteria ─────────────────────────────────────
    console.log("\n[7/8] Running acceptance-criteria checks…");

    // (a) GITHUB_TOKEN is exported
    const envToken = sshRun(host, sshPort, `printenv GITHUB_TOKEN || echo ""`);
    assert(
      "GITHUB_TOKEN is exported in the container environment",
      envToken === GITHUB_TOKEN,
      envToken
        ? `printenv GITHUB_TOKEN returned a ${envToken.length}-char value (matches PAT)`
        : "EMPTY — GITHUB_TOKEN was not exported",
    );

    // (b) Wrapper exists at /usr/local/bin/git
    const lsOut = sshRun(host, sshPort, "ls -la /usr/local/bin/git 2>&1 || echo MISSING");
    assert(
      "Git wrapper installed at /usr/local/bin/git",
      !lsOut.includes("MISSING") && lsOut.includes("/usr/local/bin/git"),
      lsOut,
    );

    // (c) Wrapper is executable
    const execCheck = sshRun(host, sshPort, "test -x /usr/local/bin/git && echo yes || echo no");
    assert("Git wrapper is executable", execCheck === "yes", `test -x → ${execCheck}`);

    // (d) git push redirects to mizi/session-{id} on GitHub (real push)
    //   We use the wrapper at /usr/local/bin/git — no stub, real /usr/bin/git.
    //   The wrapper rewrites "push origin main" → "push origin HEAD:mizi/session-{id}".
    const pushOut = sshRun(
      host, sshPort,
      `cd /tmp/test-repo && /usr/local/bin/git push origin main 2>&1 || true`,
    );
    console.log(`  Push output:\n    ${pushOut.replace(/\n/g, "\n    ")}`);

    // Verify via GitHub API that the branch now exists (not just by reading push output).
    testBranchCreated = await branchExists(SESSION_BRANCH);
    assert(
      `Branch ${SESSION_BRANCH} was created on GitHub (verified via GitHub API)`,
      testBranchCreated,
      testBranchCreated
        ? `GET /repos/${GITHUB_REPO}/branches/${SESSION_BRANCH} → 200`
        : `Branch not found on GitHub after push — push may have failed or token lacks scope`,
    );

    // (e) Non-push passes through to real git (sanity: git version works)
    const gitVersion = sshRun(host, sshPort, "/usr/local/bin/git version 2>&1 || echo FAIL");
    assert(
      "Non-push command (version) passes through to /usr/bin/git unchanged",
      gitVersion.startsWith("git version"),
      `output: ${gitVersion}`,
    );

  } finally {
    // ── 7. Cleanup ────────────────────────────────────────────────────────
    console.log("\n[8/8] Cleaning up…");

    if (testBranchCreated) {
      try {
        await deleteBranch(SESSION_BRANCH);
        console.log(`  Deleted test branch ${SESSION_BRANCH} from GitHub.`);
      } catch (err) {
        console.warn(`  Warning: could not delete branch ${SESSION_BRANCH}:`, err);
      }
    }

    if (instanceId) {
      try {
        await destroyInstance(instanceId);
        console.log(`  Instance ${instanceId} destroyed.`);
      } catch (err) {
        console.warn(`  Warning: failed to destroy instance ${instanceId}:`, err);
      }
    }

    try { fs.rmSync(sshDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ── Report ────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  console.log("\n════════════════════════════════════════════════════");
  console.log(`E2E result: ${passed}/${results.length} checks passed`);
  if (failed > 0) {
    console.log("FAILED checks:");
    results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}\n    ${r.detail}`));
    process.exit(1);
  } else {
    console.log("All checks PASSED — git push redirection works in a live container.");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("\nFatal error:", err);
  if (instanceId) {
    console.error(
      `  IMPORTANT: Instance ${instanceId} may still be running — destroy it manually via:\n` +
      `    curl -X DELETE https://cloud.vast.ai/api/v0/instances/${instanceId}/ \\n` +
      `      -H "Authorization: Bearer $VASTAI_API_KEY"`,
    );
  }
  process.exit(1);
});
