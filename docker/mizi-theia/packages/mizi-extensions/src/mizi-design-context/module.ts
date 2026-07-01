import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { AIVariableContribution } from "@theia/ai-core/lib/common/variable-service";
import { MiziDesignContextContribution } from "./frontend-contribution";
import { DesignContextWidget } from "./design-context-widget";
import { MiziDesignContextProvider } from "./backend-contribution";

const miziDesignContextModule = new ContainerModule((bind) => {
  bind(DesignContextWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(() => ({
    id: DesignContextWidget.FACTORY_ID,
    createWidget: (ctx) => ctx.container.get(DesignContextWidget),
  }));
  bind(MiziDesignContextContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziDesignContextContribution);
  bind(CommandContribution).toService(MiziDesignContextContribution);

  bind(MiziDesignContextProvider).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(MiziDesignContextProvider);
});
export { miziDesignContextModule };
export default miziDesignContextModule;
