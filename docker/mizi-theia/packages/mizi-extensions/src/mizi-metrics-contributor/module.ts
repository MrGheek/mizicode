import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { MiziMetricsContributorContribution } from "./backend-contribution";
import { MiziMetricsFrontendContribution } from "./frontend-contribution";

export const miziMetricsContributorModule = new ContainerModule((bind) => {
  bind(MiziMetricsFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziMetricsFrontendContribution);

  bind(MiziMetricsContributorContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziMetricsContributorContribution);
});
