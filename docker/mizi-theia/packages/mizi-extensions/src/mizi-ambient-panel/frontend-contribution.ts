import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { AmbientPanelWidget } from "./ambient-panel-widget";

export const OpenAmbientPanelCommand: Command = {
  id: "mizi.ambient-panel.open",
  label: "MIZI: Show Ambient Agent",
};

export const KillAmbientCommand: Command = {
  id: "mizi.ambient-panel.kill",
  label: "MIZI: Kill Ambient Agent",
};

@injectable()
export class MiziAmbientPanelContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;

  onStart(): void {
    // Widget factory registered in module
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenAmbientPanelCommand, {
      execute: () => this.openPanel(),
    });
    commands.registerCommand(KillAmbientCommand, {
      execute: () => this.killAmbient(),
    });
  }

  private async openPanel(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(AmbientPanelWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }

  private async killAmbient(): Promise<void> {
    try {
      const apiBase =
        typeof window !== "undefined" &&
        (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
          ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
          : "";
      const resp = await fetch(`${apiBase}/api/ambient/stop`, { method: "POST" });
      if (resp.ok) {
        const w = await this.widgetManager.getOrCreateWidget(AmbientPanelWidget.FACTORY_ID) as AmbientPanelWidget;
        w.addCycleEntry({ type: "system", message: "Ambient agent killed by user", timestamp: new Date().toISOString() });
      }
    } catch {
      // Silent
    }
  }
}
