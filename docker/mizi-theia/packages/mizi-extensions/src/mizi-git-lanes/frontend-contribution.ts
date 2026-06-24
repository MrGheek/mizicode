import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

export const CreateSessionBranchCommand: Command = { id: "mizi.git.createSessionBranch", label: "MIZI: Create Session Branch", category: "MIZI Git" };
export const CreateLaneBranchCommand: Command = { id: "mizi.git.createLaneBranch", label: "MIZI: Create Lane Branch", category: "MIZI Git" };
export const HandoffToPRCommand: Command = { id: "mizi.git.handoffToPR", label: "MIZI: Handoff to PR", category: "MIZI Git" };
export const PushSessionCommand: Command = { id: "mizi.git.pushSession", label: "MIZI: Push Session", category: "MIZI Git" };

@injectable()
export class MiziGitLanesContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

  onStart(): void {}

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CreateSessionBranchCommand, { execute: () => this.createBranch("session") });
    commands.registerCommand(CreateLaneBranchCommand, { execute: () => this.createBranch("lane") });
    commands.registerCommand(HandoffToPRCommand, { execute: () => this.handoff() });
    commands.registerCommand(PushSessionCommand, { execute: () => this.push() });
  }

  private async createBranch(type: "session" | "lane"): Promise<void> {
    const name = await this.quickInput.createInputBox();
    name.title = type === "session" ? "Create MIZI session branch" : "Create MIZI lane branch";
    name.placeholder = "Branch name";
    const branchName = await new Promise<string>((resolve) => {
      name.onDidAccept(() => { resolve(name.value.trim()); name.dispose(); });
      name.show();
    });
    if (!branchName) return;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/git/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: branchName, type }),
      });
      if (resp.ok) {
        this.msg.info(`Created ${type} branch: ${branchName}`);
        await fetch(`${MIZI_API_BASE}/api/git/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch: branchName }),
        });
      } else {
        this.msg.error(`Branch failed: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handoff(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/lanes/current/handoff`, { method: "POST" });
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

  private async push(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/git/push`, { method: "POST" });
      if (resp.ok) {
        this.msg.info("Session pushed to remote");
      } else {
        this.msg.error(`Push failed: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
