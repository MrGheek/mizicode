import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { QuickInputService } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";

export const AskMiziCommand: Command = {
  id: "mizi.palette.ask",
  label: "MIZI: Ask…",
  category: "MIZI",
};

export const SearchMemoryAndSkillsCommand: Command = {
  id: "mizi.palette.search-memory-skills",
  label: "MIZI: Search Memory & Skills",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

const SWITCH_MODEL_PATTERNS = [
  /switch\s+(to\s+)?(the\s+)?model/i,
  /change\s+(the\s+)?model/i,
  /use\s+different\s+model/i,
  /switch\s+nim/i,
  /model\s+switcher/i,
];

@injectable()
export class MiziAiPaletteContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(CommandRegistry) protected readonly commands: CommandRegistry;

  onStart(): void {
    // Commands registered via CommandContribution
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(AskMiziCommand, {
      execute: () => this.askMizi(),
    });
    commands.registerCommand(SearchMemoryAndSkillsCommand, {
      execute: () => this.searchMemoryAndSkills(),
    });
  }

  private async askMizi(): Promise<void> {
    const inputBox = this.quickInput.createInputBox();
    inputBox.title = "MIZI: Ask a question or describe a task";
    inputBox.placeholder = "e.g., How does session routing work? / Refactor the auth middleware to use JWT";
    inputBox.ignoreFocusOut = true;

    inputBox.step = 2;
    inputBox.totalSteps = 2;

    const text = await new Promise<string>((resolve) => {
      inputBox.onDidAccept(() => {
        const value = inputBox.value.trim();
        if (value) resolve(value);
        inputBox.dispose();
      });
      inputBox.show();
    });

    if (!text) return;

    // Check local intent patterns first
    if (SWITCH_MODEL_PATTERNS.some((p) => p.test(text))) {
      try {
        await this.commands.executeCommand("mizi.nim.switch-model");
        return;
      } catch {
        // Fall through to backend
      }
    }

    // Show intent preview — classify intent and show routing recommendation
    try {
      const classifyResp = await fetch(`${MIZI_API_BASE}/intent/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: text }),
      });

      if (classifyResp.ok) {
        const classification = (await classifyResp.json()) as {
          taskType?: string;
          complexityTier?: string;
          routingPath?: string;
          nimSuggestion?: { model?: string; provider?: string };
          gpuSuggestion?: { model?: string };
          tokenMode?: string;
          skillBundle?: string;
        };

        const routeInfo = [
          classification.complexityTier ? `Complexity: ${classification.complexityTier}` : "",
          classification.taskType ? `Task: ${classification.taskType}` : "",
          classification.routingPath ? `Route: ${classification.routingPath}` : "",
          classification.nimSuggestion?.model ? `Suggested model: ${classification.nimSuggestion.model}` : "",
          classification.tokenMode ? `Token mode: ${classification.tokenMode}` : "",
        ].filter(Boolean).join("\n");

        if (routeInfo) {
          this.msg.info(`MIZI Routing:\n${routeInfo}`, { timeout: 8000 });
        }
      } else {
        // Fall back to palette intent endpoint
        await this.callPaletteIntent(text);
      }
    } catch {
      // Fall back to palette intent endpoint
      await this.callPaletteIntent(text);
    }
  }

  private async searchMemoryAndSkills(): Promise<void> {
    const inputBox = this.quickInput.createInputBox();
    inputBox.title = "MIZI: Search Memory & Skills";
    inputBox.placeholder = "Search across memory observations and skills…";
    inputBox.ignoreFocusOut = true;

    const query = await new Promise<string>((resolve) => {
      inputBox.onDidAccept(() => {
        resolve(inputBox.value.trim());
        inputBox.dispose();
      });
      inputBox.show();
    });

    if (!query) return;

    try {
      const [memResp, skillsResp] = await Promise.all([
        fetch(`${MIZI_API_BASE}/api/memory/search?q=${encodeURIComponent(query)}&limit=20`),
        fetch(`${MIZI_API_BASE}/api/skills?q=${encodeURIComponent(query)}&limit=20`),
      ]);

      const results: Array<{ label: string; description: string; detail?: string }> = [];

      if (memResp.ok) {
        const memData = (await memResp.json()) as { results?: Array<{ content: string; type: string; relevanceScore: number; timestamp: string }> };
        for (const m of memData.results ?? []) {
          results.push({
            label: `$(database) ${m.content.substring(0, 60)}`,
            description: `Memory · ${(m.relevanceScore * 100).toFixed(0)}%`,
            detail: m.type,
          });
        }
      }

      if (skillsResp.ok) {
        const skillsData = (await skillsResp.json()) as { items?: Array<{ name: string; description: string; class?: string }> };
        for (const s of skillsData.items ?? []) {
          results.push({
            label: `$(tools) ${s.name}`,
            description: `Skill${s.class ? ` · ${s.class}` : ""}`,
            detail: s.description?.substring(0, 80),
          });
        }
      }

      if (results.length === 0) {
        this.msg.info(`No results for "${query}"`);
        return;
      }

      await this.quickInput.pick(results, { placeHolder: `Results for "${query}" (${results.length})` });
    } catch (err) {
      this.msg.error(`Search error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async callPaletteIntent(text: string): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/palette/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });
      if (!resp.ok) throw new Error(await resp.text());

      const result = (await resp.json()) as {
        intent: string;
        action: string;
        parameters?: Record<string, unknown>;
      };

      this.msg.info(`MIZI: identified intent "${result.intent}" — ${result.action}`);
    } catch (err) {
      this.msg.error(
        `MIZI palette error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
