import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { PlanViewWidget } from "./plan-view-widget";

export const OpenPlanViewCommand: Command = {
  id: "mizi.plan-view.open",
  label: "MIZI: Show Plan Board",
};

export const BrowsePlansCommand: Command = {
  id: "mizi.plan-view.browse",
  label: "MIZI: Browse Plans",
  category: "MIZI",
};

export const GeneratePlanCommand: Command = {
  id: "mizi.plan-view.generate",
  label: "MIZI: Generate Plan",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

@injectable()
export class MiziPlanViewContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

  onStart(): void {
    // Widget factory is bound in module
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OpenPlanViewCommand, {
      execute: () => this.openPlanView(),
    });
    commands.registerCommand(BrowsePlansCommand, {
      execute: () => this.browsePlans(),
    });
    commands.registerCommand(GeneratePlanCommand, {
      execute: () => this.generatePlan(),
    });
  }

  private async openPlanView(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(PlanViewWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }

  private async generatePlan(): Promise<void> {
    const inputBox = this.quickInput.createInputBox();
    inputBox.title = "MIZI: Generate Plan";
    inputBox.placeholder = "Describe the task or goal for the plan…";
    inputBox.ignoreFocusOut = true;

    const goal = await new Promise<string>((resolve) => {
      inputBox.onDidAccept(() => {
        resolve(inputBox.value.trim());
        inputBox.dispose();
      });
      inputBox.show();
    });

    if (!goal) return;

    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/plan/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      if (!resp.ok) { this.msg.warn("Failed to generate plan"); return; }

      const plan = (await resp.json()) as { id: string; goal?: string; phase?: string; lanes?: Array<{ id: string; title: string; status: string }> };
      this.msg.info(`Plan generated: ${plan.goal?.substring(0, 60) ?? goal.substring(0, 60)}`, { timeout: 5000 });

      const widget = await this.widgetManager.getOrCreateWidget(PlanViewWidget.FACTORY_ID) as PlanViewWidget;
      widget.loadPlan(plan.id);
      if (!widget.isAttached) {
        this.shell.addWidget(widget, { area: 'right' });
      }
      this.shell.activateWidget(widget.id);
    } catch (err) {
      this.msg.error(`Error generating plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async browsePlans(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/plan/history`);
      if (!resp.ok) { this.msg.warn("Plan history unavailable"); return; }
      const plans = (await resp.json()) as Array<{ id: string; goal: string; phase: string; status: string; createdAt: string; laneCount: number }>;
      if (!Array.isArray(plans) || plans.length === 0) {
        this.msg.info("No plans found");
        return;
      }
      const items = plans.map((p) => ({
        label: p.goal.substring(0, 60),
        description: `$(chip) ${p.phase}  |  $(git-branch) ${p.laneCount} lanes`,
        detail: `${p.status} · ${new Date(p.createdAt).toLocaleDateString()}`,
        planId: p.id,
      }));
      const picked = await this.quickInput.pick(items, { placeHolder: "Browse plans (select to open)" });
      if (!picked) return;
      const planId = (picked as unknown as { planId: string }).planId;
      // Navigate to the selected plan by opening the plan view widget
      const widget = await this.widgetManager.getOrCreateWidget(PlanViewWidget.FACTORY_ID) as PlanViewWidget;
      widget.loadPlan(planId);
      if (!widget.isAttached) {
        this.shell.addWidget(widget, { area: 'right' });
      }
      this.shell.activateWidget(widget.id);
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
