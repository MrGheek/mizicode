import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "http://localhost:3000";

interface MetricsSnapshot {
  gpuUtilization: number;
  gpuMemoryUsedMb: number;
  gpuMemoryTotalMb: number;
  tokensPerSecond: number;
  totalTokensUsed: number;
  totalTokensBudget: number;
  activeModel: string;
  phase: string;
  latencyMs: number;
  estimatedCost: number;
  uptime: number;
}

@injectable()
export class MiziMetricsContributorContribution implements BackendApplicationContribution {
  private current: MetricsSnapshot | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  @postConstruct()
  protected init(): void {
    this.poll().catch(() => {});
  }

  onStart(): void {
    this.intervalHandle = setInterval(() => this.poll().catch(() => {}), 15_000);
  }

  onStop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async getMetrics(): Promise<MetricsSnapshot | null> {
    if (!this.current) await this.poll();
    return this.current;
  }

  async getMetricsPrometheus(): Promise<string> {
    const m = this.current;
    if (!m) return "# MIZI metrics not available";
    return [
      "# HELP mizi_gpu_utilization GPU utilization 0-100",
      "# TYPE mizi_gpu_utilization gauge",
      `mizi_gpu_utilization ${m.gpuUtilization}`,
      "",
      "# HELP mizi_gpu_memory_mb GPU memory usage in MB",
      "# TYPE mizi_gpu_memory_mb gauge",
      `mizi_gpu_memory_mb{type="used"} ${m.gpuMemoryUsedMb}`,
      `mizi_gpu_memory_mb{type="total"} ${m.gpuMemoryTotalMb}`,
      "",
      "# HELP mizi_tokens_per_second Token throughput",
      "# TYPE mizi_tokens_per_second gauge",
      `mizi_tokens_per_second ${m.tokensPerSecond}`,
      "",
      "# HELP mizi_total_tokens Total tokens used and budget",
      "# TYPE mizi_total_tokens counter",
      `mizi_total_tokens{type="used"} ${m.totalTokensUsed}`,
      `mizi_total_tokens{type="budget"} ${m.totalTokensBudget}`,
      "",
      "# HELP mizi_latency_ms Request latency",
      "# TYPE mizi_latency_ms gauge",
      `mizi_latency_ms ${m.latencyMs}`,
      "",
      "# HELP mizi_estimated_cost Estimated session cost",
      "# TYPE mizi_estimated_cost gauge",
      `mizi_estimated_cost ${m.estimatedCost}`,
      "",
      `# active_model ${m.activeModel}`,
      `# phase ${m.phase}`,
      `# uptime ${m.uptime}`,
    ].join("\n");
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/metrics`);
      if (resp.ok) this.current = (await resp.json()) as MetricsSnapshot;
    } catch {
      this.current = null;
    }
  }
}
