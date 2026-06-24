import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziGitLanesContribution } from "./frontend-contribution";

export const miziGitLanesModule = new ContainerModule((bind) => {
  bind(MiziGitLanesContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziGitLanesContribution);
  bind(CommandContribution).toService(MiziGitLanesContribution);
});
