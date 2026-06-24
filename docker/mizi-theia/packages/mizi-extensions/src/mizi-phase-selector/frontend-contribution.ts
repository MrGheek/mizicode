import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { StatusBar, StatusBarEntry, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";

export type PhaseName = "explore" | "plan" | "implement" | "swarm" | "synthesise" | "review";

interface PhaseInfo {
  phase: PhaseName;
  label: string;
  color: string;
  colorDot: string;
  description: string;
}

const PHASES: Record<PhaseName, PhaseInfo> = {
  explore:    { phase: "explore",    label: "Explore",    color: "var(--theia-statusBar-foreground)", colorDot: "#569cd6", description: "Explore codebase and gather context" },
  plan:       { phase: "plan",       label: "Plan",       color: "var(--theia-statusBar-foreground)", colorDot: "#c586c0", description: "Design and decompose solutions" },
  implement:  { phase: "implement",  label: "Implement",  color: "var(--theia-statusBar-foreground)", colorDot: "#4ec9b0", description: "Write code guided by plan" },
  swarm:      { phase: "swarm",      label: "Swarm",      color: "var(--theia-statusBar-foreground)", colorDot: "#dcdcaa", description: "Concurrent multi-agent execution" },
  synthesise: { phase: "synthesise", label: "Synthesise", color: "var(--theia-statusBar-foreground)", colorDot: "#ce9178", description: "Merge swarm outputs into coherent result" },
  review:     { phase: "review",     label: "Review",     color: "var(--theia-statusBar-foreground)", colorDot: "#f44747", description: "Review and finalize changes" },
};

export const SelectPhaseCommand: Command = {
  id: "mizi.phase-selector.select",
  label: "MIZI: Select Phase",
};

@injectable()
export class MiziPhaseSelectorContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(StatusBar) protected readonly statusBar: StatusBar;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

  private _currentPhase: PhaseName = "explore";

  @postConstruct()
  protected init(): void {
    this.fetchCurrentPhase();
  }

  onStart(): void {
    this.updateStatusBar();
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(SelectPhaseCommand, {
      execute: () => this.selectPhase(),
    });
  }

  private updateStatusBar(): void {
    const p = PHASES[this._currentPhase];
    const entry: StatusBarEntry = {
      text: `$(primitive-dot) ${p.label}`,
      tooltip: `${p.label}: ${p.description}`,
      alignment: StatusBarAlignment.LEFT,
      command: SelectPhaseCommand.id,
      priority: 100,
    };
    this.statusBar.setElement("mizi-phase-selector", entry);
  }

  async selectPhase(): Promise<void> {
    const items = Object.values(PHASES).map((p) => ({
      label: p.label,
      description: p.description,
      mode: p.phase,
    }));
    const picked = await this.quickInput.pick(items, { placeHolder: "Select MIZI phase…" });
    if (!picked) return;
    this._currentPhase = (picked as any).mode;
    try {
      const resp = await fetch(`${this.apiBase}/api/session/phase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: (picked as any).mode }),
      });
      if (!resp.ok) throw new Error(await resp.text());
    } catch (err) {
      this.msg.error(`Failed to switch phase: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.updateStatusBar();
  }

  private get apiBase(): string {
    if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]) {
      return (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string;
    }
    return "";
  }

  private async fetchCurrentPhase(): Promise<void> {
    try {
      const resp = await fetch(`${this.apiBase}/api/session/phase`);
      if (resp.ok) {
        const data = await resp.json() as { phase: PhaseName };
        if (data.phase && PHASES[data.phase]) {
          this._currentPhase = data.phase;
        }
      }
    } catch {
      // Use default
    }
  }
}
