import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { MiziSessionStatusBarContribution } from "./frontend-contribution";

export const miziSessionStatusBarModule = new ContainerModule((bind) => {
  bind(MiziSessionStatusBarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziSessionStatusBarContribution);
});
