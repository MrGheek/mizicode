import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziAgentWorkflowsContribution } from "./backend-contribution";

export const miziAgentWorkflowsModule = new ContainerModule((bind) => {
  bind(MiziAgentWorkflowsContribution).toSelf().inSingletonScope();
});
