import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { SkillsViewWidget } from "./skills-view-widget";

export const OpenSkillsViewCommand: Command = {
  id: "mizi.skills-view.open",
  label: "MIZI: Show Skills & Eval Leaderboard",
};

@injectable()
export class MiziSkillsViewContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;

  onStart(): void {}

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenSkillsViewCommand, {
      execute: () => this.openWidget(),
    });
  }

  private async openWidget(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(SkillsViewWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }
}
