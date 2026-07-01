import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MessageService } from "@theia/core/lib/common/message-service";
import { DesignContextWidget } from "./design-context-widget";

export const OpenDesignContextCommand: Command = {
  id: "mizi.design-context.open",
  label: "MIZI: Show Design Context",
};

export const SyncDesignIntelligenceCommand: Command = {
  id: "mizi.design-context.sync",
  label: "MIZI: Sync Design Intelligence",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziDesignContextContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;
  @inject(MessageService) protected readonly msg: MessageService;

  onStart(): void {}

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenDesignContextCommand, {
      execute: () => this.open(),
    });
    commands.registerCommand(SyncDesignIntelligenceCommand, {
      execute: () => this.sync(),
    });
  }

  private async open(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(DesignContextWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }

  private async sync(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/design-intelligence/sync`, { method: "POST" });
      if (resp.ok) {
        this.msg.info("Design intelligence synced");
        // Refresh widget if open
        const widget = await this.widgetManager.getOrCreateWidget(DesignContextWidget.FACTORY_ID) as DesignContextWidget;
        if (widget.isAttached) {
          widget.refresh();
        }
      } else {
        const text = await resp.text();
        this.msg.error(`Sync failed: ${text}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
