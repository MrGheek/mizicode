import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziClawRunnerFrontendContribution } from "./frontend-contribution";

export const miziClawRunnerFrontendModule = new ContainerModule((bind) => {
  bind(MiziClawRunnerFrontendContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziClawRunnerFrontendContribution);
  bind(CommandContribution).toService(MiziClawRunnerFrontendContribution);
});
