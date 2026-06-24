import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziAiPaletteContribution } from "./frontend-contribution";

export const miziAiPaletteModule = new ContainerModule((bind) => {
  bind(MiziAiPaletteContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziAiPaletteContribution);
  bind(CommandContribution).toService(MiziAiPaletteContribution);
});
