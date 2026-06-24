import { injectable } from "@theia/core/shared/inversify";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { ChatNodeToolbarActionContribution, ChatNodeToolbarAction } from "@theia/ai-chat-ui/lib/browser/chat-node-toolbar-action-contribution";

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

const UpvoteCommand: Command = { id: "mizi.skill.upvote", label: "Helpful" };
const DownvoteCommand: Command = { id: "mizi.skill.downvote", label: "Not helpful" };

interface ResponseLike {
  response?: Record<string, unknown>;
}

@injectable()
export class MiziSkillFeedbackContribution implements CommandContribution, ChatNodeToolbarActionContribution {
  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(UpvoteCommand, {
      execute: (node: unknown) => this.sendFeedback(node as ResponseLike, "up"),
    });
    commands.registerCommand(DownvoteCommand, {
      execute: (node: unknown) => this.sendFeedback(node as ResponseLike, "down"),
    });
  }

  getToolbarActions(node: unknown): ChatNodeToolbarAction[] {
    const r = node as ResponseLike;
    if (r?.response) {
      return [
        { commandId: UpvoteCommand.id, icon: "codicon codicon-thumbsup", tooltip: "Helpful", priority: 10 },
        { commandId: DownvoteCommand.id, icon: "codicon codicon-thumbsdown", tooltip: "Not helpful", priority: 9 },
      ];
    }
    return [];
  }

  private async sendFeedback(node: ResponseLike, vote: "up" | "down"): Promise<void> {
    const activeSkillIds: string[] = (node.response?.["activeSkillIds"] as string[]) || [];
    for (const skillId of activeSkillIds) {
      try {
        await fetch(`${MIZI_API_BASE}/api/skills/${skillId}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vote }),
        });
      } catch { /* silent */ }
    }
  }
}
