import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { DesignContextWidget } from "./design-context-widget";

export const OpenDesignContextCommand: Command = {
  id: "mizi.design-context.open",
  label: "MIZI: Show Design Context",
};

@injectable()
export class MiziDesignContextContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;

  onStart(): void {}

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenDesignContextCommand, {
      execute: () => this.open(),
    });
  }

  private async open(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(DesignContextWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }
}
