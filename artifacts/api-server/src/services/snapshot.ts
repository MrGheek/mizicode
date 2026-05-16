/**
 * Workspace Snapshot Service
 *
 * Creates and manages git commit checkpoints in the session container's
 * workspace before AI agent tool calls execute. Exposes:
 *   - triggerSnapshot   — fire-and-forget; safe to call before any tool
 *   - listSnapshots     — parse mizi-created snapshot commits from git log
 *   - rollbackToSnapshot — git reset --hard to a snapshot SHA
 *
 * All shell commands are dispatched via the bridge WebSocket using a dedicated
 * `shell` frame type (handled by docker/claw-bridge.mjs). Responses arrive as
 * `shell_done` / `shell_error` frames matched by a unique request ID.
 */

import WebSocket from "ws";
import { randomBytes } from "crypto";
import { getBridge } from "./bridge-registry.js";
import { logger } from "../lib/logger.js";

export interface Snapshot {
  sha: string;
  tool: string;
  timestamp: string;
}

interface ShellResult {
  exitCode: number;
  output: string;
}

// pending: shellId -> { resolve, reject, timer }
const pendingCalls = new Map<string, {
  resolve: (r: ShellResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// WeakSet of WebSocket instances that already have our shell-response listener attached
const instrumented = new WeakSet<WebSocket>();

/**
 * Attach a persistent shell-response listener to a bridge WebSocket.
 * Safe to call multiple times — attaches at most once per WebSocket instance.
 */
function ensureShellListener(ws: WebSocket): void {
  if (instrumented.has(ws)) return;
  instrumented.add(ws);

  ws.on("message", (raw) => {
    let frame: { type: string; id?: string; exitCode?: number; output?: string; message?: string };
    try {
      frame = JSON.parse(raw.toString()) as typeof frame;
    } catch {
      return;
    }

    if (frame.type === "shell_done" && frame.id) {
      const pending = pendingCalls.get(frame.id);
      if (pending) {
        pendingCalls.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve({ exitCode: frame.exitCode ?? 0, output: frame.output ?? "" });
      }
    } else if (frame.type === "shell_error" && frame.id) {
      const pending = pendingCalls.get(frame.id);
      if (pending) {
        pendingCalls.delete(frame.id);
        clearTimeout(pending.timer);
        pending.reject(new Error(frame.message ?? "Shell error"));
      }
    }
  });
}

/**
 * Execute a shell command in the session container via the bridge.
 * Throws if the bridge is not connected or the command times out.
 */
export function execShell(
  sessionId: number,
  laneId: number,
  cmd: string,
  timeoutMs = 15_000,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const ws = getBridge(sessionId, laneId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Bridge not connected for session ${sessionId} lane ${laneId}`));
    }

    ensureShellListener(ws);

    const id = randomBytes(8).toString("hex");

    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Shell exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCalls.set(id, { resolve, reject, timer });

    ws.send(JSON.stringify({ type: "shell", id, cmd }), (err) => {
      if (err) {
        clearTimeout(timer);
        pendingCalls.delete(id);
        reject(err);
      }
    });
  });
}

/**
 * Trigger a git commit snapshot before an AI tool call.
 *
 * Returns a Promise that resolves when the snapshot commit is complete (or
 * when git is unavailable / errors occur). Callers should await this with
 * a bounded timeout and fail-open, ensuring the snapshot is a genuine
 * "before" checkpoint rather than a fire-and-forget side effect.
 *
 * Errors (bridge not connected, git not initialised, etc.) are swallowed
 * internally; the returned promise always resolves rather than rejects so
 * callers do not need a try/catch to protect the main tool flow.
 */
export async function triggerSnapshot(sessionId: number, laneId: number, toolName: string): Promise<void> {
  const ts = new Date().toISOString();
  const subject = `mizi: snapshot before ${toolName} @ ${ts}`;
  // Use --allow-empty so the commit always succeeds even when nothing changed;
  // this gives a reliable timestamp anchor even on no-op tool calls.
  const cmd = [
    "cd /workspace 2>/dev/null || cd ~ &&",
    "git add -A 2>/dev/null;",
    `git commit -m "${subject.replace(/"/g, "'")}" --allow-empty --no-verify -q 2>/dev/null || true`,
  ].join(" ");

  try {
    await execShell(sessionId, laneId, cmd, 10_000);
  } catch (err: unknown) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), sessionId, laneId, toolName },
      "[snapshot] Snapshot commit failed (non-fatal — proceeding with tool call)",
    );
  }
}

/**
 * List all mizi-created snapshot commits for a session, newest first.
 * Operates on the exact sessionId/laneId provided — does not silently
 * fall back to a different lane. Throws if the bridge is not connected.
 */
export async function listSnapshots(sessionId: number, laneId: number): Promise<Snapshot[]> {
  const cmd = [
    "cd /workspace 2>/dev/null || cd ~ &&",
    `git log --grep="^mizi: snapshot" --pretty=format:"%H|%s|%aI" 2>&1`,
  ].join(" ");

  const result = await execShell(sessionId, laneId, cmd, 15_000);

  if (result.exitCode !== 0) {
    throw new Error(
      `git log failed (exit ${result.exitCode}): ${result.output.slice(0, 300)}`,
    );
  }

  return result.output
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const pipeIdx = line.indexOf("|");
      const sha = line.slice(0, pipeIdx).trim();
      const rest = line.slice(pipeIdx + 1);
      const lastPipe = rest.lastIndexOf("|");
      const subject = rest.slice(0, lastPipe).trim();
      const timestamp = rest.slice(lastPipe + 1).trim();
      const toolMatch = subject.match(/^mizi: snapshot before (.+?) @ /);
      return {
        sha,
        tool: toolMatch?.[1] ?? "unknown",
        timestamp,
      };
    })
    .filter((s) => s.sha.length >= 7);
}

/**
 * Roll back the workspace to a snapshot commit via `git reset --hard`.
 *
 * Before executing the reset, verifies that the target SHA belongs to a
 * mizi-created snapshot commit (message starts with "mizi: snapshot") to
 * prevent arbitrary git history rewrites via this endpoint.
 *
 * Throws on invalid SHA format, non-mizi commit, bridge not connected, or
 * non-zero git exit code.
 */
export async function rollbackToSnapshot(sessionId: number, laneId: number, sha: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error("Invalid SHA format");
  }

  // Verify the SHA is a mizi snapshot commit before resetting.
  // `git log <sha>^!` prints just that single commit's metadata.
  // Uses the exact requested lane — no silent lane substitution.
  const verifyCmd = [
    "cd /workspace 2>/dev/null || cd ~ &&",
    `git log ${sha}^! --pretty=format:"%s" 2>&1`,
  ].join(" ");
  const verifyResult = await execShell(sessionId, laneId, verifyCmd, 10_000);
  if (verifyResult.exitCode !== 0) {
    throw new Error(
      `git log verify failed for SHA ${sha} (exit ${verifyResult.exitCode}): ${verifyResult.output.slice(0, 300)}`,
    );
  }
  const subject = verifyResult.output.trim();
  if (!subject.startsWith("mizi: snapshot")) {
    throw new Error(
      `SHA ${sha} is not a mizi-created snapshot commit (subject: "${subject.slice(0, 80)}")`,
    );
  }

  const cmd = [
    "cd /workspace 2>/dev/null || cd ~ &&",
    `git reset --hard ${sha} 2>&1`,
  ].join(" ");

  const result = await execShell(sessionId, laneId, cmd, 30_000);
  if (result.exitCode !== 0) {
    throw new Error(`git reset --hard failed (exit ${result.exitCode}): ${result.output.slice(0, 500)}`);
  }
}
