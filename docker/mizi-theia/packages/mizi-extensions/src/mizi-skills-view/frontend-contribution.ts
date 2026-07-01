import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { SkillsViewWidget } from "./skills-view-widget";

export const OpenSkillsViewCommand: Command = {
  id: "mizi.skills-view.open",
  label: "MIZI: Show Skills & Eval Leaderboard",
};

export const ToggleSkillBundleCommand: Command = {
  id: "mizi.skills-view.toggle-bundle",
  label: "MIZI: Toggle Skill Bundle",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziSkillsViewContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

  onStart(): void {}

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenSkillsViewCommand, {
      execute: () => this.openWidget(),
    });
    commands.registerCommand(ToggleSkillBundleCommand, {
      execute: () => this.toggleBundle(),
    });
  }

  private async openWidget(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(SkillsViewWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }

  private async toggleBundle(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/skills/bundles`);
      if (!resp.ok) { this.msg.warn("Skill bundles unavailable"); return; }
      const bundles = (await resp.json()) as Array<{ id: string; name: string; description: string; active: boolean }>;
      if (!Array.isArray(bundles) || bundles.length === 0) {
        this.msg.info("No skill bundles available");
        return;
      }
      const items = bundles.map((b) => ({
        label: b.name,
        description: b.description.substring(0, 60),
        detail: b.active ? "$(check) Active" : "$(circle-slash) Inactive",
        bundleId: b.id,
      }));
      const picked = await this.quickInput.pick(items, { placeHolder: "Toggle skill bundle (select to toggle)" });
      if (!picked) return;
      const bundleId = (picked as unknown as { bundleId: string }).bundleId;
      const bundle = bundles.find((b) => b.id === bundleId);
      const toggleResp = await fetch(`${MIZI_API_BASE}/api/skills/bundles/${bundleId}/toggle`, {
        method: "POST",
      });
      if (toggleResp.ok) {
        this.msg.info(`Skill bundle "${bundle?.name ?? bundleId}" ${bundle?.active ? "disabled" : "enabled"}`);
      } else {
        this.msg.error(`Failed to toggle bundle: ${await toggleResp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
