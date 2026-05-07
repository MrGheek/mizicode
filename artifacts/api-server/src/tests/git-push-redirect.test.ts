/**
 * git push → mizi/session-{id} redirection tests (Task #265).
 *
 * Verifies that the git wrapper installed by buildOnStartScript() actually
 * redirects pushes to the correct session branch.  Tests are run locally
 * (no real container needed) by:
 *
 *   1. Generating the onstart script via buildOnStartScript().
 *   2. Extracting the heredoc wrapper block from the script text.
 *   3. Writing the wrapper to a temp file and making it executable.
 *   4. Placing a mock /usr/bin/git stub in the same temp dir that records
 *      the args it receives, then running the wrapper against it.
 *
 * This catches heredoc quoting bugs, argument-parsing edge cases, and PATH
 * issues that code-review alone cannot surface.
 *
 * For live-container E2E verification, see:
 *   src/tests/e2e/git-push-redirect-e2e.ts
 */

import { describe, it, expect } from "vitest";
import { buildOnStartScript } from "../services/vastai";
import { spawnSync } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Extract the wrapper script text written by the cat-heredoc block. */
function extractWrapperScript(onstart: string): string {
  const start = onstart.indexOf("#!/bin/bash\nGIT=/usr/bin/git");
  if (start === -1) throw new Error("Wrapper script not found in onstart");
  const end = onstart.indexOf("\nMIZI_GIT_WRAPPER\n", start);
  if (end === -1) throw new Error("MIZI_GIT_WRAPPER end delimiter not found");
  return onstart.slice(start, end);
}

/** Build onstart + extract wrapper in one step (used by many tests). */
function makeWrapper(sessionId: number, token = "ghp_testtoken123", enableLaneBranches = false): string {
  const onstart = buildOnStartScript({
    modelRepo: "test/model", modelQuant: "Q4", servedModelName: "test",
    llamaCtxSize: 4096, llamaBatchSize: 32, llamaExtraArgs: "",
    githubToken: token, sessionId, enableLaneBranches,
  });
  return extractWrapperScript(onstart);
}

/**
 * Run the wrapper script with a controlled environment:
 *   - A mock GIT stub is written to tmpDir/usr/bin/git that writes its args
 *     to tmpDir/git-args.txt instead of performing real git operations.
 *   - GIT inside the wrapper is overridden to point at the stub.
 * Returns the recorded git arguments (one per line).
 */
function runWrapper(wrapperText: string, wrapperArgs: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-push-redirect-"));
  try {
    // Write the stub that records its invocation.
    const stubDir = path.join(tmpDir, "usr", "bin");
    fs.mkdirSync(stubDir, { recursive: true });
    const stubPath = path.join(stubDir, "git");
    const argsFile = path.join(tmpDir, "git-args.txt");
    fs.writeFileSync(
      stubPath,
      `#!/bin/bash\nprintf '%s\\n' "$@" > ${argsFile}\n`,
      { mode: 0o755 },
    );

    // Patch the wrapper to point GIT at our stub (avoids needing /usr/bin/git
    // to exist on the test host and isolates us from the real git binary).
    const patchedWrapper = wrapperText.replace(
      /^GIT=.*$/m,
      `GIT=${stubPath}`,
    );
    const wrapperPath = path.join(tmpDir, "git-wrapper");
    fs.writeFileSync(wrapperPath, patchedWrapper, { mode: 0o755 });

    const result = spawnSync("bash", [wrapperPath, ...wrapperArgs], {
      encoding: "utf8",
      timeout: 5000,
    });

    if (result.error) throw result.error;

    return fs.existsSync(argsFile)
      ? fs.readFileSync(argsFile, "utf8").trim()
      : "";
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── script generation ───────────────────────────────────────────────────────

describe("buildOnStartScript — git wrapper presence", () => {
  const sessionId = 42;
  const token = "ghp_testtoken123";

  it("includes GITHUB_TOKEN export when githubToken is provided", () => {
    const script = buildOnStartScript({
      modelRepo: "test/model", modelQuant: "Q4", servedModelName: "test",
      llamaCtxSize: 4096, llamaBatchSize: 32, llamaExtraArgs: "",
      githubToken: token, sessionId,
    });
    expect(script).toContain(`export GITHUB_TOKEN="${token}"`);
  });

  it("installs git wrapper at /usr/local/bin/git with chmod +x", () => {
    const script = buildOnStartScript({
      modelRepo: "test/model", modelQuant: "Q4", servedModelName: "test",
      llamaCtxSize: 4096, llamaBatchSize: 32, llamaExtraArgs: "",
      githubToken: token, sessionId,
    });
    expect(script).toContain("cat > /usr/local/bin/git << 'MIZI_GIT_WRAPPER'");
    expect(script).toContain("chmod +x /usr/local/bin/git");
  });

  it("bakes the session ID into the wrapper as a literal integer (no shell variable)", () => {
    const script = buildOnStartScript({
      modelRepo: "test/model", modelQuant: "Q4", servedModelName: "test",
      llamaCtxSize: 4096, llamaBatchSize: 32, llamaExtraArgs: "",
      githubToken: token, sessionId,
    });
    // TypeScript interpolates the session ID at generation time — the produced
    // shell script must contain the integer literally, NOT a shell ${...}
    // expansion, so it works even when the wrapper is run in a shell that has
    // no SESSION_ID variable set.
    expect(script).toContain(`HEAD:mizi/session-${sessionId}`);
    expect(script).not.toContain("HEAD:mizi/session-${");
  });

  it("omits the git wrapper when githubToken is not provided", () => {
    const script = buildOnStartScript({
      modelRepo: "test/model", modelQuant: "Q4", servedModelName: "test",
      llamaCtxSize: 4096, llamaBatchSize: 32, llamaExtraArgs: "",
    });
    expect(script).not.toContain("MIZI_GIT_WRAPPER");
    expect(script).not.toContain("GITHUB_TOKEN");
  });

  it("omits the git wrapper when sessionId is not provided", () => {
    const script = buildOnStartScript({
      modelRepo: "test/model", modelQuant: "Q4", servedModelName: "test",
      llamaCtxSize: 4096, llamaBatchSize: 32, llamaExtraArgs: "",
      githubToken: token,
      // sessionId intentionally omitted
    });
    expect(script).not.toContain("MIZI_GIT_WRAPPER");
  });

  it("configures git credential substitution for the PAT", () => {
    const script = buildOnStartScript({
      modelRepo: "test/model", modelQuant: "Q4", servedModelName: "test",
      llamaCtxSize: 4096, llamaBatchSize: 32, llamaExtraArgs: "",
      githubToken: token, sessionId,
    });
    expect(script).toContain(`https://${token}@github.com/`);
    expect(script).toContain(`push.default current`);
  });
});

// ─── shell-level wrapper behaviour ───────────────────────────────────────────

describe("git wrapper shell behaviour — push redirection", () => {
  const sessionId = 99;

  it("redirects plain `git push` to HEAD:mizi/session-{id} on remote origin", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["push"]);
    const args = recorded.split("\n");
    expect(args).toContain("push");
    expect(args).toContain("origin");
    expect(args).toContain(`HEAD:mizi/session-${sessionId}`);
  });

  it("redirects `git push origin` (explicit remote) to correct branch", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["push", "origin"]);
    const args = recorded.split("\n");
    expect(args).toContain("origin");
    expect(args).toContain(`HEAD:mizi/session-${sessionId}`);
  });

  it("redirects `git push upstream` (non-default remote) preserving remote name", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["push", "upstream"]);
    const args = recorded.split("\n");
    expect(args).toContain("upstream");
    expect(args).toContain(`HEAD:mizi/session-${sessionId}`);
    expect(args).not.toContain("origin");
  });

  it("passes `git status` through to /usr/bin/git unchanged", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["status"]);
    const args = recorded.split("\n");
    expect(args).toContain("status");
    expect(recorded).not.toContain("mizi/session");
  });

  it("passes `git commit -m msg` through unchanged", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["commit", "-m", "test commit"]);
    const args = recorded.split("\n");
    expect(args).toContain("commit");
    expect(args).toContain("-m");
    expect(args).toContain("test commit");
    expect(recorded).not.toContain("mizi/session");
  });

  it("passes `git fetch origin` through unchanged", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["fetch", "origin"]);
    const args = recorded.split("\n");
    expect(args).toContain("fetch");
    expect(args).toContain("origin");
    expect(recorded).not.toContain("mizi/session");
  });

  it("handles `git -c color.ui=never push origin` (global flag before subcommand)", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["-c", "color.ui=never", "push", "origin"]);
    const args = recorded.split("\n");
    expect(args).toContain("push");
    expect(args).toContain("origin");
    expect(args).toContain(`HEAD:mizi/session-${sessionId}`);
  });

  it("handles `git --no-pager push` (long flag before subcommand)", () => {
    const wrapper = makeWrapper(sessionId);
    const recorded = runWrapper(wrapper, ["--no-pager", "push"]);
    const args = recorded.split("\n");
    expect(args).toContain("push");
    expect(args).toContain(`HEAD:mizi/session-${sessionId}`);
  });
});

// ─── cross-session isolation ──────────────────────────────────────────────────

describe("git wrapper — session ID isolation", () => {
  it("two different session IDs produce two different branch targets with no cross-contamination", () => {
    const r1 = runWrapper(makeWrapper(1), ["push"]);
    const r2 = runWrapper(makeWrapper(2), ["push"]);

    expect(r1).toContain("HEAD:mizi/session-1");
    expect(r2).toContain("HEAD:mizi/session-2");
    expect(r1).not.toContain("mizi/session-2");
    expect(r2).not.toContain("mizi/session-1");
  });
});
