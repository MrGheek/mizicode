import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MiziSnapshotRollbackContribution } from "./frontend-contribution";

export const miziSnapshotRollbackModule = new ContainerModule((bind) => {
  bind(MiziSnapshotRollbackContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziSnapshotRollbackContribution);
  bind(CommandContribution).toService(MiziSnapshotRollbackContribution);
});
