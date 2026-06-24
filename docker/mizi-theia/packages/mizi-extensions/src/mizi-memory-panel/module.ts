import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { MiziMemoryPanelContribution } from "./frontend-contribution";
import { MemoryPanelWidget } from "./memory-panel-widget";

export const miziMemoryPanelModule = new ContainerModule((bind) => {
  bind(MemoryPanelWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(() => ({
    id: MemoryPanelWidget.FACTORY_ID,
    createWidget: (ctx) => ctx.container.get(MemoryPanelWidget),
  }));
  bind(MiziMemoryPanelContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziMemoryPanelContribution);
  bind(CommandContribution).toService(MiziMemoryPanelContribution);
});
