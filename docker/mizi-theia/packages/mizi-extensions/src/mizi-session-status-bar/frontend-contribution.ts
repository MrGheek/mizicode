import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { StatusBar, StatusBarEntry, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";

interface SessionHealth {
  sessionId: number | null;
  phase: string;
  activeModel: string | null;
  activeProvider: string | null;
  modelRoutingMode: "auto" | "pinned" | null;
  tokenBudget: number;
  tokenUsed: number;
  gpuCost: number;
  status: "healthy" | "degraded" | "error";
}

interface SwarmModelResponse {
  sessionId: number | null;
  phase: string;
  recommendation: { modelId: string; provider: string; latencyMs: number | null } | null;
  scored: Array<{ modelId: string; provider: string; score: number; latencyMs: number | null }>;
}

interface VLLMStatus {
  pid: number | null;
  status: "running" | "stopped" | "error";
  model: string | null;
  gpuUtilization: number;
  memoryUsedMb: number;
  uptime: number;
}

interface RoutingStats {
  modelSwitches: number;
  phaseTransitions: number;
  lastModelSwitch: string | null;
  lastPhaseTransition: string | null;
  autoDecisions: number;
  pinnedOverrides: number;
}

interface CostBreakdown {
  totalCost: number;
  sessionCost: number;
  perPhase: Record<string, number>;
  estimatedTotalBudget: number;
}

export const StopSessionCommand: Command = {
  id: "mizi.session.stop",
  label: "MIZI: Stop Session",
  category: "MIZI",
};

export const RefreshSessionCommand: Command = {
  id: "mizi.session.refresh",
  label: "MIZI: Refresh Session Status",
  category: "MIZI",
};

export const OpenSessionDashboardCommand: Command = {
  id: "mizi.session.open-dashboard",
  label: "MIZI: Open Session Dashboard",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziSessionStatusBarContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(StatusBar) protected readonly statusBar: StatusBar;
  @inject(MessageService) protected readonly msg: MessageService;
  private health: SessionHealth | null = null;
  private swarmModel: SwarmModelResponse | null = null;
  private vllmStatus: VLLMStatus | null = null;
  private routingStats: RoutingStats | null = null;
  private costBreakdown: CostBreakdown | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  @postConstruct()
  protected init(): void {
    this.poll();
  }

  onStart(): void {
    this.render();
    this.intervalHandle = setInterval(() => this.poll(), 30_000);
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(StopSessionCommand, {
      execute: () => this.stopSession(),
    });
    commands.registerCommand(RefreshSessionCommand, {
      execute: () => this.refreshSession(),
    });
    commands.registerCommand(OpenSessionDashboardCommand, {
      execute: () => this.openSessionDashboard(),
    });
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

      // Also fetch swarm model when in swarm phase
      if (this.health?.phase === "swarm") {
        const swarmResp = await fetch(`${MIZI_API_BASE}/api/session/swarm-model`);
        if (swarmResp.ok) this.swarmModel = (await swarmResp.json()) as SwarmModelResponse;
      } else {
        this.swarmModel = null;
      }

      // Fetch routing stats and cost breakdown
      const [statsResp, costResp] = await Promise.all([
        fetch(`${MIZI_API_BASE}/api/session/routing-stats`),
        fetch(`${MIZI_API_BASE}/api/session/cost-breakdown`),
      ]);
      if (statsResp.ok) this.routingStats = (await statsResp.json()) as RoutingStats;
      if (costResp.ok) this.costBreakdown = (await costResp.json()) as CostBreakdown;
    } catch {
      this.health = null;
      this.vllmStatus = null;
      this.swarmModel = null;
      this.routingStats = null;
      this.costBreakdown = null;
    }
    this.render();
  }

  private sessionId(): number | null {
    return this.health?.sessionId ?? null;
  }

  private async stopSession(): Promise<void> {
    const sid = this.sessionId();
    if (!sid) { this.msg.warn("No active session"); return; }
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}`, { method: "DELETE" });
      if (resp.ok) this.msg.info("Session stopped");
      else this.msg.warn(`Failed to stop session: ${await resp.text()}`);
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async refreshSession(): Promise<void> {
    const sid = this.sessionId();
    if (!sid) { this.msg.warn("No active session"); return; }
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}/refresh`, { method: "POST" });
      if (resp.ok) { this.msg.info("Session status refreshed"); this.poll(); }
      else this.msg.warn(`Refresh failed: ${await resp.text()}`);
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async openSessionDashboard(): Promise<void> {
    const sid = this.sessionId();
    if (!sid) { this.msg.warn("No active session"); return; }
    window.open(`/sessions/${sid}`, "_blank");
  }

  private render(): void {
    if (!this.health) {
      this.statusBar.setElement("mizi-session-status", { text: "", alignment: StatusBarAlignment.LEFT, priority: 0 });
      return;
    }
    const pct = this.health.tokenBudget > 0
      ? Math.round((this.health.tokenUsed / this.health.tokenBudget) * 100)
      : 0;

    const routingIcon = this.health.modelRoutingMode === "pinned" ? "$(lock)" : "$(sync)";

    const vllmLabel = this.vllmStatus
      ? (this.vllmStatus.status === "running" ? "$(check) vLLM" : "$(circle-slash) vLLM")
      : "";

    const modelLabel = this.health.activeModel
      ? `NIM/${this.health.activeModel.substring(0, 16)}`
      : "$(circle-slash) NIM";

    const swarmLabel = this.swarmModel?.recommendation
      ? ` | swarm: ${this.swarmModel.recommendation.modelId.substring(0, 14)}`
      : "";

    const parts = [
      `$(chip) ${this.health.phase}`,
      `${routingIcon}`,
      `$(circuit-board) ${modelLabel}${swarmLabel}`,
      `$(graph) ${pct}%`,
    ];
    if (vllmLabel) parts.push(vllmLabel);

    const tooltipLines = [
      `Phase: ${this.health.phase}`,
      `Routing: ${this.health.modelRoutingMode ?? "unknown"}`,
      `Model: ${this.health.activeModel || "none"}`,
      `GPU cost: $${this.health.gpuCost.toFixed(4)}`,
      `Tokens: ${this.health.tokenUsed.toLocaleString()} / ${this.health.tokenBudget.toLocaleString()}`,
      `Status: ${this.health.status}`,
    ];

    if (this.routingStats) {
      tooltipLines.push(
        "",
        "Routing Stats:",
        `  Model switches: ${this.routingStats.modelSwitches}`,
        `  Phase transitions: ${this.routingStats.phaseTransitions}`,
        `  Auto decisions: ${this.routingStats.autoDecisions}`,
        `  Pinned overrides: ${this.routingStats.pinnedOverrides}`,
        `  Last switch: ${this.routingStats.lastModelSwitch ?? "N/A"}`,
        `  Last transition: ${this.routingStats.lastPhaseTransition ?? "N/A"}`,
      );
    }

    if (this.costBreakdown) {
      const phaseCosts = Object.entries(this.costBreakdown.perPhase ?? {})
        .map(([p, c]) => `  ${p}: $${c.toFixed(4)}`)
        .join("\n");
      tooltipLines.push(
        "",
        "Cost Breakdown:",
        `  Session: $${this.costBreakdown.sessionCost.toFixed(4)}`,
        `  Total: $${this.costBreakdown.totalCost.toFixed(4)}`,
        `  Budget: $${this.costBreakdown.estimatedTotalBudget.toFixed(4)}`,
        phaseCosts ? `  Per phase:\n${phaseCosts}` : "",
      );
    }

    if (this.swarmModel?.recommendation) {
      tooltipLines.push(
        "",
        `Swarm model: ${this.swarmModel.recommendation.modelId}`,
        `Swarm provider: ${this.swarmModel.recommendation.provider}`,
        `Swarm latency: ${this.swarmModel.recommendation.latencyMs?.toFixed(0) ?? "?"}ms`,
      );
    }

    if (this.vllmStatus) {
      tooltipLines.push(
        "",
        `vLLM: ${this.vllmStatus.status}`,
        `vLLM model: ${this.vllmStatus.model ?? "N/A"}`,
        `vLLM GPU: ${this.vllmStatus.gpuUtilization.toFixed(1)}%`,
        `vLLM uptime: ${Math.floor(this.vllmStatus.uptime)}s`,
      );
    }

    tooltipLines.push("", "Click to switch NIM model");

    const entry: StatusBarEntry = {
      text: parts.join(" | "),
      tooltip: tooltipLines.join("\n"),
      alignment: StatusBarAlignment.LEFT,
      priority: 95,
      command: "mizi.nim.switch-model",
    };
    this.statusBar.setElement("mizi-session-status", entry);
  }
}
