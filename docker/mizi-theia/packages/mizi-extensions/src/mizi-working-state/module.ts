import { ContainerModule } from "@theia/core/shared/inversify";
import { AIVariableContribution } from "@theia/ai-core/lib/common/variable-service";
import { MiziWorkingStateContribution } from "./backend-contribution";

export const miziWorkingStateModule = new ContainerModule((bind) => {
  bind(MiziWorkingStateContribution).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(MiziWorkingStateContribution);
});
