import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziTerminalOpsContribution } from "./backend-contribution";

const miziTerminalOpsModule = new ContainerModule((bind) => {
  bind(MiziTerminalOpsContribution).toSelf().inSingletonScope();
});
export { miziTerminalOpsModule };
export default miziTerminalOpsModule;
