import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { StatusBar, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { QuickInputService } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";

interface NimModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  available: boolean;
}

interface ScoredModel {
  nimModelId: string;
  displayName: string;
  provider: string;
  latencyMs: number | null;
  score: number;
  qualityComponent: number;
  costComponent: number;
  throughputComponent: number;
  sweBenchScore: number | null;
  throughputClass: string | null;
}

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

interface ProviderHealth {
  provider: string;
  status: "healthy" | "degraded" | "error";
  latencyMs: number | null;
  costPerMillion: number;
}

export const SwitchNimModelCommand: Command = {
  id: "mizi.nim.switch-model",
  label: "MIZI: Switch NIM Model",
  category: "MIZI",
};

export const ToggleRoutingModeCommand: Command = {
  id: "mizi.nim.toggle-routing-mode",
  label: "MIZI: Toggle Routing Mode",
  category: "MIZI",
};

export const ShowModelHistoryCommand: Command = {
  id: "mizi.nim.model-history",
  label: "MIZI: Show Model History",
  category: "MIZI",
};

export const ShowProviderHealthCommand: Command = {
  id: "mizi.nim.provider-health",
  label: "MIZI: Provider Health",
  category: "MIZI",
};

export const ShowHardwareRecommendationsCommand: Command = {
  id: "mizi.nim.hardware-recs",
  label: "MIZI: Hardware Recommendations",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziNimProviderFrontendContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(StatusBar) protected readonly statusBar: StatusBar;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;
  @inject(MessageService) protected readonly msg: MessageService;

  private models: NimModel[] = [];
  private activeModelId: string | null = null;
  private health: SessionHealth | null = null;
  private providers: ProviderHealth[] = [];

  async onStart(): Promise<void> {
    await this.fetchHealth();
    await this.fetchModels();
    await this.fetchProviderHealth();
    this.renderStatusBar();
    this.startPolling();
  }

  onStop(): void {
    this.statusBar.removeElement("mizi-nim-status");
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(SwitchNimModelCommand, {
      execute: () => this.showRankedModelPicker(),
    });
    commands.registerCommand(ToggleRoutingModeCommand, {
      execute: () => this.toggleRoutingMode(),
    });
    commands.registerCommand(ShowModelHistoryCommand, {
      execute: () => this.showModelHistory(),
    });
    commands.registerCommand(ShowProviderHealthCommand, {
      execute: () => this.showProviderHealth(),
    });
    commands.registerCommand(ShowHardwareRecommendationsCommand, {
      execute: () => this.showHardwareRecommendations(),
    });
  }

  private startPolling(): void {
    setInterval(() => this.fetchModels(), 120_000);
    setInterval(() => this.fetchHealth(), 30_000);
    setInterval(() => this.fetchProviderHealth(), 60_000);
  }

  private async fetchModels(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/nim-models`);
      if (resp.ok) {
        this.models = (await resp.json()) as NimModel[];
        this.renderStatusBar();
      }
    } catch {
      this.models = [];
      this.renderStatusBar();
    }
  }

  private async fetchHealth(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/session/health`);
      if (resp.ok) {
        this.health = (await resp.json()) as SessionHealth;
        this.activeModelId = this.health.activeModel;
        this.renderStatusBar();
      }
    } catch {
      this.health = null;
    }
  }

  private async fetchProviderHealth(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/nim/health`);
      if (resp.ok) {
        this.providers = (await resp.json()) as ProviderHealth[];
        this.renderStatusBar();
      }
    } catch {
      this.providers = [];
    }
  }

  private renderStatusBar(): void {
    const available = this.models.filter((m) => m.available);
    const routingIcon = this.health?.modelRoutingMode === "pinned" ? "$(lock)" : "$(sync)";
    const modeLabel = this.health?.modelRoutingMode ?? "";

    if (available.length === 0) {
      this.statusBar.setElement("mizi-nim-status", {
        text: `$(circle-slash) NIM`,
        tooltip: "NIM unreachable — check MIZI_API_BASE and NIM_API_KEY",
        alignment: StatusBarAlignment.RIGHT,
        priority: 85,
        command: SwitchNimModelCommand.id,
      });
      return;
    }
    const activeName = this.activeModelId
      ? available.find((m) => m.id === this.activeModelId)?.name || this.activeModelId
      : available[0].name;
    const healthLine = this.health
      ? `Phase: ${this.health.phase}\nTokens: ${this.health.tokenUsed.toLocaleString()} / ${this.health.tokenBudget.toLocaleString()}\nGPU cost: $${this.health.gpuCost.toFixed(4)}\nStatus: ${this.health.status}`
      : "";
    const providerLines = this.providers.length > 0
      ? ["\nProviders:", ...this.providers.map((p) =>
          `  ${p.provider}: ${p.status === "healthy" ? "$(check)" : "$(circle-slash)"} ${p.latencyMs?.toFixed(0) ?? "?"}ms · $${p.costPerMillion.toFixed(2)}/M`
        )].join("\n")
      : "";

    this.statusBar.setElement("mizi-nim-status", {
      text: `$(circuit-board) NIM/${activeName.substring(0, 20)} ${modeLabel ? `${routingIcon} ${modeLabel}` : ""}`,
      tooltip: [
        `NVIDIA NIM: ${available.length} model(s) available`,
        `Active: ${activeName}`,
        `Routing: ${this.health?.modelRoutingMode ?? "unknown"}`,
        `Active provider: ${this.health?.activeProvider ?? "unknown"}`,
        healthLine,
        providerLines,
        "",
        "Left-click: switch model",
        "Right-click: toggle routing mode",
      ].join("\n"),
      alignment: StatusBarAlignment.RIGHT,
      priority: 85,
      command: SwitchNimModelCommand.id,
    });
  }

  private async showRankedModelPicker(): Promise<void> {
    let scored: ScoredModel[] = [];
    let phaseName = "";
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/session/inference-ranking`);
      if (resp.ok) {
        const data = (await resp.json()) as { phase: string; ranked: ScoredModel[] };
        phaseName = data.phase;
        scored = data.ranked;
      }
    } catch {
      // Fall through to flat list
    }

    if (scored.length > 0) {
      const quickPick = this.quickInput.createQuickPick<{
        label: string;
        description: string;
        detail: string;
        modelId: string;
      }>();
      quickPick.title = `MIZI: Switch Model — Phase: ${phaseName}`;
      quickPick.placeholder = "Select a model (ranked for current phase)…";
      quickPick.items = scored.map((m) => ({
        label: m.displayName,
        description: `$(circuit-board) ${m.provider}  |  $(plus) ${m.score.toFixed(3)}`,
        detail: [
          `SWE-bench: ${m.sweBenchScore ?? "?"}`,
          `Throughput: ${m.throughputClass ?? "?"}`,
          `Latency: ${m.latencyMs?.toFixed(0) ?? "?"}ms`,
          `Quality: ${m.qualityComponent.toFixed(3)}  Cost: ${m.costComponent.toFixed(3)}  Throughput: ${m.throughputComponent.toFixed(3)}`,
        ].join(" · "),
        modelId: m.nimModelId,
      }));

      quickPick.onDidAccept(async () => {
        const picked = quickPick.selectedItems[0];
        if (!picked) return;
        quickPick.dispose();
        await this.doSwitchModel((picked as unknown as { modelId: string }).modelId, picked.label);
      });

      quickPick.show();
    } else {
      await this.showFlatModelPicker();
    }
  }

  private async showFlatModelPicker(): Promise<void> {
    if (this.models.length === 0) {
      this.msg.warn("No NIM models available.");
      return;
    }
    const quickPick = this.quickInput.createQuickPick<{ label: string; description: string; modelId: string }>();
    quickPick.title = "MIZI: Switch NIM Model";
    quickPick.placeholder = "Select a NIM model…";
    quickPick.items = this.models.map((m) => ({
      label: m.name || m.id,
      description: `${m.available ? "$(check)" : "$(circle-slash)"} ${m.contextLength.toLocaleString()} ctx`,
      modelId: m.id,
    }));

    quickPick.onDidAccept(async () => {
      const picked = quickPick.selectedItems[0];
      if (!picked) return;
      quickPick.dispose();
      await this.doSwitchModel((picked as unknown as { modelId: string }).modelId, picked.label);
    });

    quickPick.show();
  }

  private async doSwitchModel(modelId: string, label: string): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/session/model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      if (resp.ok) {
        this.activeModelId = modelId;
        this.renderStatusBar();
        this.msg.info(`Switched to NIM model: ${label}`);
      } else {
        this.msg.error(`Failed to switch model: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Switch error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toggleRoutingMode(): Promise<void> {
    const current = this.health?.modelRoutingMode ?? "auto";
    const target = current === "auto" ? "pinned" : "auto";
    const items = [{
      label: "$(sync) Auto (phase-driven)",
      description: "Router picks best model per phase automatically",
      mode: "auto" as const,
    }, {
      label: "$(lock) Pinned (user-locked)",
      description: "Current model is locked regardless of phase",
      mode: "pinned" as const,
    }];
    const picked = await this.quickInput.pick(items, {
      placeHolder: `Current: ${current}`,
    });
    if (!picked) return;

    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/session/routing-mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: picked.mode }),
      });
      if (resp.ok) {
        if (this.health) this.health.modelRoutingMode = picked.mode;
        this.renderStatusBar();
        this.msg.info(`Routing mode set to: ${picked.mode}`);
      } else {
        this.msg.error(`Failed to update routing mode: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async showModelHistory(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/session/model-history`);
      if (!resp.ok) { this.msg.warn("No model history available"); return; }
      const history = (await resp.json()) as Array<Record<string, unknown>>;
      if (!Array.isArray(history) || history.length === 0) {
        this.msg.info("No model switches recorded yet");
        return;
      }
      const items = history.slice(0, 20).map((h) => ({
        label: `${String(h.fromModelId ?? "?").substring(0, 24)} → ${String(h.toModelId ?? "?").substring(0, 24)}`,
        description: h.reason ? String(h.reason) : "",
        detail: `At: ${String(h.switchedAt ?? "")} · Cost: ${String(h.estimatedCost ?? "?")}`,
      }));
      await this.quickInput.pick(items, { placeHolder: "Model switch history (last 20)" });
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async showProviderHealth(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/nim/health`);
      if (!resp.ok) { this.msg.warn("Provider health unavailable"); return; }
      const providers = (await resp.json()) as ProviderHealth[];
      if (!Array.isArray(providers) || providers.length === 0) {
        this.msg.info("No provider health data");
        return;
      }
      const items = providers.map((p) => ({
        label: p.provider,
        description: p.status === "healthy" ? "$(check) Healthy" : p.status === "degraded" ? "$(alert) Degraded" : "$(circle-slash) Error",
        detail: `Latency: ${p.latencyMs?.toFixed(0) ?? "?"}ms · Cost: $${p.costPerMillion.toFixed(2)}/M tokens`,
      }));
      await this.quickInput.pick(items, { placeHolder: "NIM Provider Health" });
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async showHardwareRecommendations(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/nim/recommendations`);
      if (!resp.ok) { this.msg.warn("Hardware recommendations unavailable"); return; }
      const data = (await resp.json()) as Array<{ provider: string; model: string; gpu: string; vram: string; costPerHour: number; tier: string }>;
      if (!Array.isArray(data) || data.length === 0) {
        this.msg.info("No hardware recommendations available");
        return;
      }
      const items = data.map((r) => ({
        label: `${r.provider} / ${r.model}`,
        description: `$(chip) ${r.gpu}`,
        detail: `VRAM: ${r.vram} · Cost: $${r.costPerHour.toFixed(2)}/hr · Tier: ${r.tier}`,
      }));
      await this.quickInput.pick(items, { placeHolder: "Hardware Recommendations" });
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
