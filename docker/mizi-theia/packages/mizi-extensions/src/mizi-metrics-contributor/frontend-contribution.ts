import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

export interface MetricsSnapshot {
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
  history: Array<{
    timestamp: number;
    gpuUtilization: number;
    tokensPerSecond: number;
    latencyMs: number;
    estimatedCost: number;
  }>;
}

@injectable()
export class MiziMetricsFrontendContribution implements FrontendApplicationContribution {
  private _current: MetricsSnapshot | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private listeners: Array<(data: MetricsSnapshot | null) => void> = [];

  get current(): MetricsSnapshot | null { return this._current; }

  onData(cb: (data: MetricsSnapshot | null) => void): () => void {
    this.listeners.push(cb);
    if (this._current) cb(this._current);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  @postConstruct()
  protected init(): void {
    this.poll();
  }

  onStart(): void {
    this.intervalHandle = setInterval(() => this.poll(), 30_000);
  }

  onStop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/metrics`);
      if (resp.ok) {
        this._current = (await resp.json()) as MetricsSnapshot;
        for (const cb of this.listeners) cb(this._current);
      }
    } catch {
      this._current = null;
      for (const cb of this.listeners) cb(null);
    }
  }
}
