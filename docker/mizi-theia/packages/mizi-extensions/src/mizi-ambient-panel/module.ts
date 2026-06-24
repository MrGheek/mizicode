import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { MiziAmbientPanelContribution } from "./frontend-contribution";
import { AmbientPanelWidget } from "./ambient-panel-widget";

export const miziAmbientPanelModule = new ContainerModule((bind) => {
  bind(AmbientPanelWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(() => ({
    id: AmbientPanelWidget.FACTORY_ID,
    createWidget: (ctx) => ctx.container.get(AmbientPanelWidget),
  }));
  bind(MiziAmbientPanelContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziAmbientPanelContribution);
  bind(CommandContribution).toService(MiziAmbientPanelContribution);
});
