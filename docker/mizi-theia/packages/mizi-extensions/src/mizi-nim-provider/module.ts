import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { MiziNimProviderContribution } from "./backend-contribution";

export const miziNimProviderModule = new ContainerModule((bind) => {
  bind(MiziNimProviderContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziNimProviderContribution);
});
