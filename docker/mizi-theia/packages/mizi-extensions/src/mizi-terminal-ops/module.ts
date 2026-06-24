import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziTerminalOpsContribution } from "./backend-contribution";

export const miziTerminalOpsModule = new ContainerModule((bind) => {
  bind(MiziTerminalOpsContribution).toSelf().inSingletonScope();
});
