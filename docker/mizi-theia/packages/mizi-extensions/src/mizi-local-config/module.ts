import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { MiziLocalConfigContribution } from "./backend-contribution";
import { MiziLocalConfigFrontendContribution } from "./frontend-contribution";

const miziLocalConfigBackendModule = new ContainerModule((bind) => {
  bind(MiziLocalConfigContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziLocalConfigContribution);
});

const miziLocalConfigFrontendModule = new ContainerModule((bind) => {
  bind(MiziLocalConfigFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziLocalConfigFrontendContribution);
});

export { miziLocalConfigBackendModule, miziLocalConfigFrontendModule };
export default miziLocalConfigBackendModule;
