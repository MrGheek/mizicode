import { ContainerModule } from "@theia/core/shared/inversify";
import { AIVariableContribution } from "@theia/ai-core/lib/common/variable-service";
import { MiziDesignContextProvider } from "./backend-contribution";

const miziDesignContextBackendModule = new ContainerModule((bind) => {
  bind(MiziDesignContextProvider).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(MiziDesignContextProvider);
});

export { miziDesignContextBackendModule };
export default miziDesignContextBackendModule;
