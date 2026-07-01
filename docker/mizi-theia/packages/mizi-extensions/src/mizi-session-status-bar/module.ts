import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziSessionStatusBarContribution } from "./frontend-contribution";

export const miziSessionStatusBarModule = new ContainerModule((bind) => {
  bind(MiziSessionStatusBarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziSessionStatusBarContribution);
  bind(CommandContribution).toService(MiziSessionStatusBarContribution);
});
