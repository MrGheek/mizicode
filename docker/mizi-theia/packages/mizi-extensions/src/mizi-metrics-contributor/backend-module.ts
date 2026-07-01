import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { MiziMetricsContributorContribution } from "./backend-contribution";

const miziMetricsContributorBackendModule = new ContainerModule((bind) => {
  bind(MiziMetricsContributorContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziMetricsContributorContribution);
});

export { miziMetricsContributorBackendModule };
export default miziMetricsContributorBackendModule;
