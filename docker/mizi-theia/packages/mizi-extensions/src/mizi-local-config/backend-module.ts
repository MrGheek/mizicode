import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { MiziLocalConfigContribution } from "./backend-contribution";

const miziLocalConfigBackendModule = new ContainerModule((bind) => {
  bind(MiziLocalConfigContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziLocalConfigContribution);
});

export { miziLocalConfigBackendModule };
export default miziLocalConfigBackendModule;
