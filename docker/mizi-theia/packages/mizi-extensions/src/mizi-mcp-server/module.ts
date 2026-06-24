import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziMCPServerContribution } from "./backend-contribution";

export const miziMCPServerModule = new ContainerModule((bind) => {
  bind(MiziMCPServerContribution).toSelf().inSingletonScope();
});
