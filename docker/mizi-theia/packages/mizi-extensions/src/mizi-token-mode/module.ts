import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziTokenModeContribution } from "./frontend-contribution";

export const miziTokenModeModule = new ContainerModule((bind) => {
  bind(MiziTokenModeContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziTokenModeContribution);
  bind(CommandContribution).toService(MiziTokenModeContribution);
});
