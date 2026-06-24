import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { StatusBar, StatusBarEntry, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import {
  AIVariableService,
  AIVariableContribution,
  AIVariable,
} from "@theia/ai-core/lib/common/variable-service";

export type TokenMode = "lean" | "core" | "full" | "ultra";

interface TokenModeProfile {
  mode: TokenMode;
  label: string;
  description: string;
  maxContextBudget: number;
  activeSkillCountLimit: number;
}

const TOKEN_MODE_PROFILES: Record<TokenMode, TokenModeProfile> = {
  lean:  { mode: "lean",  label: "Lean",  description: "32K budget, 4 skills, minimal memory recall",  maxContextBudget: 32768,  activeSkillCountLimit: 4 },
  core:  { mode: "core",  label: "Core",  description: "65K budget, 5 skills, moderate recall",        maxContextBudget: 65536,  activeSkillCountLimit: 5 },
  full:  { mode: "full",  label: "Full",  description: "128K budget, 7 skills, deep recall",            maxContextBudget: 128000, activeSkillCountLimit: 7 },
  ultra: { mode: "ultra", label: "Ultra", description: "16K budget, 3 skills, focused precision",      maxContextBudget: 16384,  activeSkillCountLimit: 3 },
};

export const SelectTokenModeCommand: Command = {
  id: "mizi.token-mode.select",
  label: "MIZI: Select Token Mode",
};

@injectable()
export class MiziTokenModeContribution implements FrontendApplicationContribution, CommandContribution, AIVariableContribution {
  @inject(StatusBar) protected readonly statusBar: StatusBar;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;
  @inject(AIVariableService) protected readonly variableService: AIVariableService;

  private _currentMode: TokenMode = "core";
  private tokenUsed = 0;

  readonly budgetVariable: AIVariable = {
    id: "mizi_token_budget",
    name: "mizi_token_budget",
    description: "Current token budget consumption (used / max)",
  };

  @postConstruct()
  protected init(): void {
    this.variableService.registerVariable(this.budgetVariable);
    this.fetchCurrentMode();
  }

  registerVariables(service: AIVariableService): void {
    service.registerVariable(this.budgetVariable);
  }

  onStart(): void {
    this.updateStatusBar();
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(SelectTokenModeCommand, {
      execute: () => this.selectMode(),
    });
  }

  private updateStatusBar(): void {
    const profile = TOKEN_MODE_PROFILES[this._currentMode];
    const pct = profile.maxContextBudget > 0
      ? Math.round((this.tokenUsed / profile.maxContextBudget) * 100)
      : 0;
    const entry: StatusBarEntry = {
      text: `$(circle-medium) ${profile.label} ${pct}%`,
      tooltip: `${profile.label}: ${this.tokenUsed.toLocaleString()} / ${profile.maxContextBudget.toLocaleString()} tokens (${pct}%)\nSkills: ${profile.activeSkillCountLimit}`,
      alignment: StatusBarAlignment.LEFT,
      command: SelectTokenModeCommand.id,
      priority: 90,
    };
    this.statusBar.setElement("mizi-token-mode", entry);
  }

  async selectMode(): Promise<void> {
    const items = Object.values(TOKEN_MODE_PROFILES).map((p) => ({
      label: p.label,
      description: `${p.maxContextBudget.toLocaleString()} tokens · ${p.activeSkillCountLimit} skills`,
      detail: p.description,
      mode: p.mode,
    }));
    const picked = await this.quickInput.pick(items, { placeHolder: "Select token mode…" });
    if (!picked) return;
    this._currentMode = (picked as any).mode;
    try {
      const resp = await fetch(`${this.apiBase}/api/session/token-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: (picked as any).mode }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const p = TOKEN_MODE_PROFILES[(picked as any).mode];
      this.msg.info(`Switched to ${p.label} mode (${p.maxContextBudget.toLocaleString()} token budget)`);
    } catch (err) {
      this.msg.error(`Failed to switch token mode: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.updateStatusBar();
  }

  private get apiBase(): string {
    if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]) {
      return (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string;
    }
    return "";
  }

  private async fetchCurrentMode(): Promise<void> {
    try {
      const resp = await fetch(`${this.apiBase}/api/session/token-mode`);
      if (resp.ok) {
        const data = await resp.json() as { mode: TokenMode; tokenUsed?: number };
        if (data.mode && TOKEN_MODE_PROFILES[data.mode]) {
          this._currentMode = data.mode;
          if (typeof data.tokenUsed === "number") this.tokenUsed = data.tokenUsed;
        }
      }
    } catch {
      // Use default
    }
  }
}
