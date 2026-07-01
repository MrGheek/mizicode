import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { SnapshotListWidget } from "./snapshot-list-widget";

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

interface SnapshotCommit {
  hash: string;
  timestamp: string;
  message: string;
}

export const ListSnapshotsCommand: Command = {
  id: "mizi.snapshot.list",
  label: "MIZI: List Snapshots",
};

export const RollbackToSnapshotCommand: Command = {
  id: "mizi.snapshot.rollback",
  label: "MIZI: Rollback to Snapshot…",
};

export const OpenSnapshotsListCommand: Command = {
  id: "mizi.snapshot.open-list",
  label: "MIZI: Show Snapshots",
};

@injectable()
export class MiziSnapshotRollbackContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;
  @inject(WidgetManager) protected readonly widgetManager: WidgetManager;
  @inject(ApplicationShell) protected readonly shell: ApplicationShell;

  onStart(): void {}

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ListSnapshotsCommand, {
      execute: () => this.listSnapshots(),
    });
    commands.registerCommand(RollbackToSnapshotCommand, {
      execute: () => this.rollback(),
    });
    commands.registerCommand(OpenSnapshotsListCommand, {
      execute: () => this.openSnapshotsWidget(),
    });
  }

  private async openSnapshotsWidget(): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(SnapshotListWidget.FACTORY_ID);
    if (!widget.isAttached) {
      this.shell.addWidget(widget, { area: 'right' });
    }
    this.shell.activateWidget(widget.id);
  }

  private async listSnapshots(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/snapshots`);
      if (!resp.ok) { this.msg.error("Failed to fetch snapshots"); return; }
      const snapshots = (await resp.json()) as SnapshotCommit[];
      if (snapshots.length === 0) {
        this.msg.info("No snapshots found.");
        return;
      }
      const items = snapshots.map((s) => ({
        label: s.hash.substring(0, 7),
        description: s.message,
        detail: new Date(s.timestamp).toLocaleString(),
      }));
      await this.quickInput.pick(items, { placeHolder: "Snapshots" });
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async rollback(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/snapshots`);
      if (!resp.ok) { this.msg.error("Failed to fetch snapshots"); return; }
      const snapshots = (await resp.json()) as SnapshotCommit[];
      const items = snapshots.map((s) => ({
        label: s.hash.substring(0, 7),
        description: s.message,
        detail: new Date(s.timestamp).toLocaleString(),
        hash: s.hash,
      }));
      const picked = await this.quickInput.pick(items, { placeHolder: "Select snapshot to rollback to…" });
      if (!picked) return;

      const pickedItem = picked as any;
      const confirmed = await this.quickInput.pick(
        [
          { label: "Yes, rollback now", description: "This will reset working tree to this snapshot", value: true },
          { label: "Cancel", description: "Keep current state", value: false },
        ],
        { placeHolder: `Rollback to ${pickedItem.label}?` }
      );
      if (!confirmed || !(confirmed as any).value) return;

      const rollbackResp = await fetch(`${MIZI_API_BASE}/api/snapshots/${pickedItem.hash}/rollback`, {
        method: "POST",
      });
      if (rollbackResp.ok) {
        this.msg.info(`Rolled back to ${pickedItem.label}: ${pickedItem.description}`);
      } else {
        this.msg.error(`Rollback failed: ${await rollbackResp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
