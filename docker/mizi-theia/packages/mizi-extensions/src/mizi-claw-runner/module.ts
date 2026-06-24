import { ContainerModule } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { MiziClawRunnerContribution } from "./backend-contribution";

export const miziClawRunnerModule = new ContainerModule((bind) => {
  bind(MiziClawRunnerContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MiziClawRunnerContribution);
});
