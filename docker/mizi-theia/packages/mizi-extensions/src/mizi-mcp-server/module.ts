import { ContainerModule } from "@theia/core/shared/inversify";
import { MiziMCPServerContribution } from "./backend-contribution";

const miziMCPServerModule = new ContainerModule((bind) => {
  bind(MiziMCPServerContribution).toSelf().inSingletonScope();
});
export { miziMCPServerModule };
export default miziMCPServerModule;
