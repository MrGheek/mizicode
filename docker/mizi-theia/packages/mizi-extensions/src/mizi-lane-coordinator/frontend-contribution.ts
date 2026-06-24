import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { StatusBar, StatusBarEntry, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import { EditorWidget } from "@theia/editor/lib/browser/editor-widget";

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

interface LaneStatus {
  laneId: string;
  title: string;
  claim: string | null;
  blastRadius: string[];
  status: string;
}

interface ClaimStatus {
  claimed: boolean;
  claimedBy?: string;
  laneId?: string;
  laneTitle?: string;
}

export const PickLaneCommand: Command = {
  id: "mizi.lane.pick",
  label: "MIZI: Switch Lane",
};

export const ClaimLaneCommand: Command = {
  id: "mizi.lane.claim",
  label: "MIZI: Claim Current Lane",
};

export const HandoffLaneCommand: Command = {
  id: "mizi.lane.handoff",
  label: "MIZI: Handoff Lane to PR",
};

@injectable()
export class MiziLaneCoordinatorContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(StatusBar) protected readonly statusBar: StatusBar;
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;
  @inject(EditorManager) protected readonly editorManager: EditorManager;

  private laneStatus: LaneStatus | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private fileClaimCache = new Map<string, ClaimStatus>();

  @postConstruct()
  protected init(): void {
    this.poll();
  }

  onStart(): void {
    this.updateStatusBar();
    this.intervalHandle = setInterval(() => this.poll(), 15_000);
    this.editorManager.onCurrentEditorChanged(() => this.onEditorChanged());
  }

  onStop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(PickLaneCommand, {
      execute: () => this.pickLane(),
    });
    commands.registerCommand(ClaimLaneCommand, {
      execute: () => this.claimLane(),
    });
    commands.registerCommand(HandoffLaneCommand, {
      execute: () => this.handoffLane(),
    });
  }

  private async onEditorChanged(): Promise<void> {
    const editor = this.editorManager.currentEditor;
    if (!editor) return;
    const uri = editor.editor.uri.toString();
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/lanes/claim-status?file=${encodeURIComponent(uri)}`);
      if (resp.ok) {
        const status = (await resp.json()) as ClaimStatus;
        this.fileClaimCache.set(uri, status);
        this.updateGutter(editor, status);
      }
    } catch { /* ignore */ }
  }

  private updateGutter(editor: EditorWidget, status: ClaimStatus): void {
    if (!status.claimed || !status.claimedBy) return;
    const decoration = status.claimedBy === "me"
      ? { lines: { backgroundColor: "rgba(78, 201, 176, 0.1)" } }
      : { lines: { backgroundColor: "rgba(244, 71, 71, 0.1)" } };
    editor.editor.deltaDecorations({ oldDecorations: [], newDecorations: [{ range: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, options: { isWholeLine: true, className: status.claimedBy === "me" ? "mizi-lane-own" : "mizi-lane-other" } }] });
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/lanes/current`);
      if (resp.ok) {
        this.laneStatus = (await resp.json()) as LaneStatus;
        this.updateStatusBar();
      }
    } catch {
      this.laneStatus = null;
    }
  }

  private updateStatusBar(): void {
    if (!this.laneStatus) {
      this.statusBar.setElement("mizi-lane-coordinator", {
        text: "$(git-branch) No lane",
        tooltip: "No active MIZI lane",
        alignment: StatusBarAlignment.LEFT,
        priority: 70,
        command: PickLaneCommand.id,
      });
      return;
    }
    const entry: StatusBarEntry = {
      text: `$(git-branch) ${this.laneStatus.title}`,
      tooltip: `Lane: ${this.laneStatus.title}\nClaim: ${this.laneStatus.claim ?? "unclaimed"}\nStatus: ${this.laneStatus.status}\nBlast radius: ${(this.laneStatus.blastRadius ?? []).join(", ") || "none"}`,
      alignment: StatusBarAlignment.LEFT,
      priority: 70,
      command: PickLaneCommand.id,
    };
    this.statusBar.setElement("mizi-lane-coordinator", entry);
  }

  private async pickLane(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/lanes`);
      if (!resp.ok) { this.msg.error("Failed to list lanes"); return; }
      const lanes = (await resp.json()) as LaneStatus[];
      const items = lanes.map((l) => ({
        label: l.title,
        description: l.claim ? `Claimed by ${l.claim}` : "Unclaimed",
        detail: `Blast radius: ${(l.blastRadius ?? []).join(", ") || "none"}`,
        laneId: l.laneId,
      }));
      const picked = await this.quickInput.pick(items, { placeHolder: "Select lane…" });
      if (!picked) return;

      const pickedId = (picked as any).laneId;
      await fetch(`${MIZI_API_BASE}/api/lanes/${pickedId}/switch`, { method: "POST" });
      this.laneStatus = lanes.find((l) => l.laneId === pickedId) ?? null;
      this.updateStatusBar();
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async claimLane(): Promise<void> {
    if (!this.laneStatus) { this.msg.warn("No active lane"); return; }
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/lanes/${this.laneStatus.laneId}/claim`, {
        method: "POST",
      });
      if (resp.ok) {
        this.msg.info(`Claimed lane: ${this.laneStatus.title}`);
        this.laneStatus.claim = "me";
        this.updateStatusBar();
      } else {
        this.msg.error(`Claim failed: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handoffLane(): Promise<void> {
    if (!this.laneStatus) { this.msg.warn("No active lane"); return; }
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/lanes/${this.laneStatus.laneId}/handoff`, {
        method: "POST",
      });
      if (resp.ok) {
        const data = (await resp.json()) as { prUrl?: string };
        this.msg.info(`Handoff complete${data.prUrl ? `: ${data.prUrl}` : ""}`);
      } else {
        this.msg.error(`Handoff failed: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
