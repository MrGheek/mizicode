import { ContainerModule } from "@theia/core/shared/inversify";
import { AIVariableContribution } from "@theia/ai-core/lib/common/variable-service";
import { MiziRepoContextProviderContribution } from "./backend-contribution";

const miziRepoContextProviderModule = new ContainerModule((bind) => {
  bind(MiziRepoContextProviderContribution).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(MiziRepoContextProviderContribution);
});
export { miziRepoContextProviderModule };
export default miziRepoContextProviderModule;
