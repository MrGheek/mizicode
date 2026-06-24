import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziPhaseSelectorContribution } from "./frontend-contribution";

export const miziPhaseSelectorModule = new ContainerModule((bind) => {
  bind(MiziPhaseSelectorContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziPhaseSelectorContribution);
  bind(CommandContribution).toService(MiziPhaseSelectorContribution);
});
