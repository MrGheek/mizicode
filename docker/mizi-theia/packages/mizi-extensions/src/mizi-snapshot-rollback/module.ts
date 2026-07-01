import { ContainerModule } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution } from "@theia/core/lib/common/command";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { MiziSnapshotRollbackContribution } from "./frontend-contribution";
import { SnapshotListWidget } from "./snapshot-list-widget";

export const miziSnapshotRollbackModule = new ContainerModule((bind) => {
  bind(MiziSnapshotRollbackContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(MiziSnapshotRollbackContribution);
  bind(CommandContribution).toService(MiziSnapshotRollbackContribution);
  bind(WidgetFactory).toDynamicValue((ctx) => ({
    id: SnapshotListWidget.FACTORY_ID,
    async createWidget(): Promise<SnapshotListWidget> {
      return ctx.container.resolve(SnapshotListWidget);
    },
  }));
});
