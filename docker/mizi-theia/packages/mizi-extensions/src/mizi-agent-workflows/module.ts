import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziAgentWorkflowsContribution } from "./backend-contribution";

const miziAgentWorkflowsModule = new ContainerModule((bind) => {
  bind(MiziAgentWorkflowsContribution).toSelf().inSingletonScope();
});
export { miziAgentWorkflowsModule };
export default miziAgentWorkflowsModule;
