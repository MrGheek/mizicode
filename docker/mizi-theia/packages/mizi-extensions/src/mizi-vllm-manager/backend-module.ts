import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { MiziVLLMManagerContribution } from "./backend-contribution";

const miziVLLMManagerBackendModule = new ContainerModule((bind) => {
  bind(MiziVLLMManagerContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziVLLMManagerContribution);
});

export { miziVLLMManagerBackendModule };
export default miziVLLMManagerBackendModule;
