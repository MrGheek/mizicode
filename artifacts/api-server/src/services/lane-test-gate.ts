/**
 * lane-test-gate.ts — RFC 0002 Phase 1 (test-gated merges)
 *
 * Every clean lane merge is gated on the session's test command. A failure
 * undoes just that one merge (the caller aborts the merge) and skips the lane,
 * then the queue continues — one rejected lane never blocks the batch.
 *
 * The command runner is pluggable so the gate logic is unit-testable without
 * executing real test suites.
 */

import { spawnSync } from "child_process";
import { logger } from "../lib/logger";

export interface TestGateResult {
  passed: boolean;
  output: string;
}

/** Minimal contract consumed by the merge queue (defined in lane-merge.ts). */
export interface TestGate {
  run(repoPath: string, sessionId: number): Promise<TestGateResult>;
}

export type CommandRunner = (cmd: string, args: string[], cwd: string) => { status: number; stdout: string; stderr: string };

/** Default runner: spawnSync with argv arrays (no shell: true). */
export const defaultCommandRunner: CommandRunner = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120_000 });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

export interface TestGateOptions {
  /** Command to run, e.g. "npm". */
  command: string;
  /** Args, e.g. ["test"]. */
  args: string[];
  /** Override the runner (tests inject a fake). */
  runner?: CommandRunner;
}

export class LaneTestGate implements TestGate {
  constructor(private opts: TestGateOptions) {}

  async run(repoPath: string, _sessionId: number): Promise<TestGateResult> {
    const runner = this.opts.runner ?? defaultCommandRunner;
    try {
      const res = runner(this.opts.command, this.opts.args, repoPath);
      const output = `${res.stdout}\n${res.stderr}`.trim();
      if (res.status !== 0) {
        logger.debug({ repoPath, status: res.status }, "[lane-test-gate] test command failed");
        return { passed: false, output };
      }
      return { passed: true, output };
    } catch (err) {
      logger.warn({ err, repoPath }, "[lane-test-gate] test command threw");
      return { passed: false, output: String(err) };
    }
  }
}

/**
 * Resolve the session's test command from env/config. Defaults to
 * `npm test`; operators can override per-session via MIZI_TEST_COMMAND.
 */
export function resolveTestCommand(sessionId: number): TestGateOptions {
  const env = process.env["MIZI_TEST_COMMAND"]?.trim();
  if (env) {
    const parts = env.split(/\s+/);
    return { command: parts[0]!, args: parts.slice(1) };
  }
  void sessionId;
  return { command: "npm", args: ["test"] };
}