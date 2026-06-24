import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MemoryPanelWidget } from "./memory-panel-widget";

export const OpenMemoryPanelCommand: Command = {
  id: "mizi.memory-panel.open",
  label: "MIZI: Show Memory Panel",
};

@injectable()
export class MiziMemoryPanelContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;

  onStart(): void {
    // Widget factory registered in module
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenMemoryPanelCommand, {
      execute: () => this.openPanel(),
    });
  }

  private async openPanel(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(MemoryPanelWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }
}
