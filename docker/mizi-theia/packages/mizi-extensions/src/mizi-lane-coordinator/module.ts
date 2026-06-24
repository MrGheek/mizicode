import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziLaneCoordinatorContribution } from "./frontend-contribution";

export const miziLaneCoordinatorModule = new ContainerModule((bind) => {
  bind(MiziLaneCoordinatorContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziLaneCoordinatorContribution);
  bind(CommandContribution).toService(MiziLaneCoordinatorContribution);
});
