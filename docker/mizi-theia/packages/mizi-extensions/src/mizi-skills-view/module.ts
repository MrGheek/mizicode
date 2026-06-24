import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { MiziSkillsViewContribution } from "./frontend-contribution";
import { SkillsViewWidget } from "./skills-view-widget";

export const miziSkillsViewModule = new ContainerModule((bind) => {
  bind(SkillsViewWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(() => ({
    id: SkillsViewWidget.FACTORY_ID,
    createWidget: (ctx) => ctx.container.get(SkillsViewWidget),
  }));
  bind(MiziSkillsViewContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziSkillsViewContribution);
  bind(CommandContribution).toService(MiziSkillsViewContribution);
});
