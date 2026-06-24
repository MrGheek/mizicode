import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { MiziPlanViewContribution } from "./frontend-contribution";
import { PlanViewWidget } from "./plan-view-widget";

export const miziPlanViewModule = new ContainerModule((bind) => {
  bind(PlanViewWidget).toSelf();
  bind(WidgetFactory).toDynamicValue((ctx) => ({
    id: PlanViewWidget.FACTORY_ID,
    createWidget: () => ctx.container.get(PlanViewWidget),
  }));
  bind(MiziPlanViewContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziPlanViewContribution);
  bind(CommandContribution).toService(MiziPlanViewContribution);
});
