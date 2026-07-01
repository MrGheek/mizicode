import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { ConnectionContainerModule } from "@theia/core/lib/node/messaging/connection-container-module";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziNimModelManager } from "./mizi-nim-model-manager";
import { miziNimConnectionModule } from "./mizi-nim-connection-module";
import { MiziNimProviderFrontendContribution } from "./frontend-contribution";

const miziNimProviderBackendModule = new ContainerModule((bind) => {
  bind(MiziNimModelManager).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziNimModelManager);
  bind(ConnectionContainerModule).toConstantValue(miziNimConnectionModule);
});

const miziNimProviderFrontendModule = new ContainerModule((bind) => {
  bind(MiziNimProviderFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziNimProviderFrontendContribution);
  bind(CommandContribution).toService(MiziNimProviderFrontendContribution);
});

export { miziNimProviderBackendModule, miziNimProviderFrontendModule };
export default miziNimProviderBackendModule;
