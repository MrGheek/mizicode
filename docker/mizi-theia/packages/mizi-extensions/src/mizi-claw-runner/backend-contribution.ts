import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "http://localhost:3000";

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
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/jobs`);
      if (resp.ok) return (await resp.json()) as SwarmJob[];
    } catch { /* ignore */ }
    return [];
  }

  async startJob(prompt: string, model?: string, maxTurns = 10): Promise<SwarmJob | null> {
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
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/stop/${jobId}`, { method: "POST" });
      return resp.ok;
    } catch { return false; }
  }

  private streamJobOutput(jobId: string): void {
    this.sseAbortController?.abort();
    const abort = new AbortController();
    this.sseAbortController = abort;

    const source = new EventSource(`${MIZI_API_BASE}/api/swarm/stream/${jobId}`);
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
