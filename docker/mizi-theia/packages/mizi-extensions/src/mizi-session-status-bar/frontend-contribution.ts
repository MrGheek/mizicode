import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { StatusBar, StatusBarEntry, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";

interface SessionHealth {
  phase: string;
  activeModel: string;
  gpuCost: number;
  status: "healthy" | "degraded" | "error";
  tokenBudget: number;
  tokenUsed: number;
}

interface VLLMStatus {
  pid: number | null;
  status: "running" | "stopped" | "error";
  model: string | null;
  gpuUtilization: number;
  memoryUsedMb: number;
  uptime: number;
}

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziSessionStatusBarContribution implements FrontendApplicationContribution {
  @inject(StatusBar) protected readonly statusBar: StatusBar;
  private health: SessionHealth | null = null;
  private vllmStatus: VLLMStatus | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  @postConstruct()
  protected init(): void {
    this.poll();
  }

  onStart(): void {
    this.render();
    this.intervalHandle = setInterval(() => this.poll(), 30_000);
  }

  onStop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private async poll(): Promise<void> {
    try {
      const [healthResp, vllmResp] = await Promise.all([
        fetch(`${MIZI_API_BASE}/api/session/health`),
        fetch(`${MIZI_API_BASE}/api/vllm/status`),
      ]);
      if (healthResp.ok) this.health = (await healthResp.json()) as SessionHealth;
      if (vllmResp.ok) this.vllmStatus = (await vllmResp.json()) as VLLMStatus;
    } catch {
      this.health = null;
      this.vllmStatus = null;
    }
    this.render();
  }

  private render(): void {
    if (!this.health) {
      this.statusBar.setElement("mizi-session-status", { text: "", alignment: StatusBarAlignment.LEFT, priority: 0 });
      return;
    }
    const pct = this.health.tokenBudget > 0
      ? Math.round((this.health.tokenUsed / this.health.tokenBudget) * 100)
      : 0;

    const vllmLabel = this.vllmStatus
      ? (this.vllmStatus.status === "running" ? "$(check) vLLM" : "$(circle-slash) vLLM")
      : "";

    const parts = [
      `$(chip) ${this.health.phase}`,
      `$(circuit-board) ${this.health.activeModel.substring(0, 16)}`,
      `$(graph) ${pct}%`,
    ];
    if (vllmLabel) parts.push(vllmLabel);

    const entry: StatusBarEntry = {
      text: parts.join(" | "),
      tooltip: [
        `Phase: ${this.health.phase}`,
        `Model: ${this.health.activeModel}`,
        `GPU cost: $${this.health.gpuCost.toFixed(4)}`,
        `Tokens: ${this.health.tokenUsed.toLocaleString()} / ${this.health.tokenBudget.toLocaleString()}`,
        `Status: ${this.health.status}`,
        ...(this.vllmStatus ? [
          `vLLM: ${this.vllmStatus.status}`,
          `vLLM model: ${this.vllmStatus.model ?? "N/A"}`,
          `vLLM GPU: ${this.vllmStatus.gpuUtilization.toFixed(1)}%`,
          `vLLM uptime: ${Math.floor(this.vllmStatus.uptime)}s`,
        ] : []),
      ].join("\n"),
      alignment: StatusBarAlignment.LEFT,
      priority: 95,
    };
    this.statusBar.setElement("mizi-session-status", entry);
  }
}
