import { ContainerModule } from "@theia/core/shared/inversify";
import { AIVariableContribution } from "@theia/ai-core/lib/common/variable-service";
import { MiziMemoryBridgeContribution } from "./backend-contribution";

export const miziMemoryBridgeModule = new ContainerModule((bind) => {
  bind(MiziMemoryBridgeContribution).toSelf().inSingletonScope();
  bind(AIVariableContribution).toService(MiziMemoryBridgeContribution);
});
