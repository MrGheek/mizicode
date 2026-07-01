import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { ConnectionContainerModule } from "@theia/core/lib/node/messaging/connection-container-module";
import { MiziNimModelManager } from "./mizi-nim-model-manager";
import { miziNimConnectionModule } from "./mizi-nim-connection-module";

const miziNimProviderBackendModule = new ContainerModule((bind) => {
  bind(MiziNimModelManager).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziNimModelManager);
  bind(ConnectionContainerModule).toConstantValue(miziNimConnectionModule);
});

export { miziNimProviderBackendModule };
export default miziNimProviderBackendModule;
