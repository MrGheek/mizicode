import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { PlanViewWidget } from "./plan-view-widget";

export const OpenPlanViewCommand: Command = {
  id: "mizi.plan-view.open",
  label: "MIZI: Show Plan Board",
};

@injectable()
export class MiziPlanViewContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;

  onStart(): void {
    // Widget factory is bound in module
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenPlanViewCommand, {
      execute: () => this.openPlanView(),
    });
  }

  private async openPlanView(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(PlanViewWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }
}
