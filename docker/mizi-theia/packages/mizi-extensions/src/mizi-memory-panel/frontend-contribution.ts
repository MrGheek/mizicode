import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { MemoryPanelWidget } from "./memory-panel-widget";

export const OpenMemoryPanelCommand: Command = {
  id: "mizi.memory-panel.open",
  label: "MIZI: Show Memory Panel",
};

export const SearchMemoryCommand: Command = {
  id: "mizi.memory-panel.search",
  label: "MIZI: Search Memory",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziMemoryPanelContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

  onStart(): void {
    // Widget factory registered in module
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenMemoryPanelCommand, {
      execute: () => this.openPanel(),
    });
    commands.registerCommand(SearchMemoryCommand, {
      execute: () => this.searchMemory(),
    });
  }

  private async openPanel(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(MemoryPanelWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }

  private async searchMemory(): Promise<void> {
    const inputBox = this.quickInput.createInputBox();
    inputBox.title = "MIZI: Search Memory";
    inputBox.placeholder = "Enter search query…";
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
      const resp = await fetch(`${MIZI_API_BASE}/api/mem/observations/search?q=${encodeURIComponent(query)}`);
      if (!resp.ok) { this.msg.warn("Memory search unavailable"); return; }
      const data = (await resp.json()) as { results: Array<{ id: string; content: string; type: string; relevanceScore: number; timestamp: string }> };
      if (!data.results || data.results.length === 0) {
        this.msg.info("No matching memories found");
        return;
      }
      const items = data.results.map((m) => ({
        label: m.content.substring(0, 60),
        description: `${(m.relevanceScore * 100).toFixed(0)}% · ${m.type}`,
        detail: new Date(m.timestamp).toLocaleString(),
      }));
      await this.quickInput.pick(items, { placeHolder: `Memory results for "${query}"` });
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
