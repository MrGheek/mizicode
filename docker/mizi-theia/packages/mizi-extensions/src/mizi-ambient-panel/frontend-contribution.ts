import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { AmbientPanelWidget } from "./ambient-panel-widget";

export const OpenAmbientPanelCommand: Command = {
  id: "mizi.ambient-panel.open",
  label: "MIZI: Show Ambient Agent",
};

export const KillAmbientCommand: Command = {
  id: "mizi.ambient-panel.kill",
  label: "MIZI: Kill Ambient Agent",
};

export const EditAmbientConfigCommand: Command = {
  id: "mizi.ambient-panel.edit-config",
  label: "MIZI: Edit Ambient Config",
  category: "MIZI",
};

export const ShowSafetyPolicyCommand: Command = {
  id: "mizi.ambient-panel.safety-policy",
  label: "MIZI: Safety Policy",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziAmbientPanelContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

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
    commands.registerCommand(EditAmbientConfigCommand, {
      execute: () => this.editConfig(),
    });
    commands.registerCommand(ShowSafetyPolicyCommand, {
      execute: () => this.showSafetyPolicy(),
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
      const resp = await fetch(`${MIZI_API_BASE}/api/ambient/stop`, { method: "POST" });
      if (resp.ok) {
        const w = await this.widgetManager.getOrCreateWidget(AmbientPanelWidget.FACTORY_ID) as AmbientPanelWidget;
        w.addCycleEntry({ type: "system", message: "Ambient agent killed by user", timestamp: new Date().toISOString() });
      }
    } catch {
      // Silent
    }
  }

  private async editConfig(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/ambient/config`);
      if (!resp.ok) { this.msg.warn("Ambient config unavailable"); return; }
      const config = (await resp.json()) as Record<string, unknown>;

      const inputBox = this.quickInput.createInputBox();
      inputBox.title = "MIZI: Edit Ambient Config (JSON)";
      inputBox.value = JSON.stringify(config, null, 2);
      inputBox.ignoreFocusOut = true;

      const result = await new Promise<string>((resolve) => {
        inputBox.onDidAccept(() => {
          resolve(inputBox.value);
          inputBox.dispose();
        });
        inputBox.show();
      });

      if (!result) return;
      const parsed = JSON.parse(result);
      const updateResp = await fetch(`${MIZI_API_BASE}/api/ambient/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (updateResp.ok) {
        this.msg.info("Ambient config updated");
      } else {
        this.msg.error(`Failed to update config: ${await updateResp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async showSafetyPolicy(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/ambient/safety-policy`);
      if (!resp.ok) { this.msg.warn("Safety policy unavailable"); return; }
      const data = (await resp.json()) as { rules: Array<{ id: string; description: string; enabled: boolean }> };
      if (!data.rules || data.rules.length === 0) {
        this.msg.info("No safety policy rules defined");
        return;
      }
      const items = data.rules.map((r) => ({
        label: `${r.enabled ? "$(check)" : "$(circle-slash)"} ${r.id}`,
        description: r.description.substring(0, 80),
      }));
      await this.quickInput.pick(items, { placeHolder: "Safety Policy Rules" });
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
