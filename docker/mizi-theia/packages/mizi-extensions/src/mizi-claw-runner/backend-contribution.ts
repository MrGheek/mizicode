import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "";

interface SwarmJob {
  jobId: string;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  model: string;
  turns: number;
  maxTurns: number;
  output?: string;
  error?: string;
  createdAt: string;
}

function isLocalMode(): boolean {
  return !MIZI_API_BASE || (() => {
    try { const u = new URL(MIZI_API_BASE); return u.hostname === "localhost" || u.hostname === "127.0.0.1"; }
    catch { return true; }
  })();
}

@injectable()
export class MiziClawRunnerContribution implements BackendApplicationContribution {
  private activeJob: SwarmJob | null = null;
  private sseAbortController: AbortController | null = null;

  @postConstruct()
  protected init(): void {}

  onStart(): void {}

  onStop(): void {
    this.sseAbortController?.abort();
  }

  async listJobs(): Promise<SwarmJob[]> {
    if (isLocalMode()) {
      const { listJobs: localList } = await import("../mizi-nim-provider/local-swarm-orchestrator");
      const localJobs = localList();
      return localJobs.map((j) => ({
        jobId: j.id,
        status: j.status === "aborted" ? "failed" as const : j.status as SwarmJob["status"],
        prompt: j.goal,
        model: j.subtasks[0]?.modelId ?? "",
        turns: 0,
        maxTurns: 10,
        output: j.result,
        error: j.error,
        createdAt: j.createdAt,
      }));
    }
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/jobs`);
      if (resp.ok) return (await resp.json()) as SwarmJob[];
    } catch { /* ignore */ }
    return [];
  }

  async startJob(prompt: string, model?: string, maxTurns = 10): Promise<SwarmJob | null> {
    if (isLocalMode()) {
      const { startSwarmJob } = await import("../mizi-nim-provider/local-swarm-orchestrator");
      const job = await startSwarmJob(prompt, []);
      const result: SwarmJob = {
        jobId: job.id,
        status: job.status as SwarmJob["status"],
        prompt: job.goal,
        model: job.subtasks[0]?.modelId ?? model ?? "",
        turns: 0,
        maxTurns,
        output: job.result,
        error: job.error,
        createdAt: job.createdAt,
      };
      this.activeJob = result;
      return result;
    }
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, model, maxTurns }),
      });
      if (resp.ok) {
        const job = (await resp.json()) as SwarmJob;
        this.activeJob = job;
        this.streamJobOutput(job.jobId);
        return job;
      }
    } catch { /* ignore */ }
    return null;
  }

  async stopJob(jobId: string): Promise<boolean> {
    if (isLocalMode()) {
      const { abortJob } = await import("../mizi-nim-provider/local-swarm-orchestrator");
      return abortJob(jobId);
    }
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/stop/${jobId}`, { method: "POST" });
      return resp.ok;
    } catch { return false; }
  }

  private streamJobOutput(jobId: string): void {
    this.sseAbortController?.abort();
    const abort = new AbortController();
    this.sseAbortController = abort;

    const base = MIZI_API_BASE || "http://localhost:3000";
    const source = new EventSource(`${base}/api/swarm/stream/${jobId}`);
    source.addEventListener("message", (event) => {
      try {
        const update = JSON.parse(event.data) as Partial<SwarmJob>;
        if (this.activeJob && this.activeJob.jobId === jobId) {
          this.activeJob = { ...this.activeJob, ...update };
        }
      } catch { /* ignore */ }
    });
    source.addEventListener("complete", () => {
      source.close();
      this.activeJob = null;
    });
    abort.signal.addEventListener("abort", () => source.close());
  }
}
