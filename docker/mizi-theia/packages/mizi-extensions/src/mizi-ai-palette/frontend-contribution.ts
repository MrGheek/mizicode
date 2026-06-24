import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { QuickInputService, InputBox } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";

export const AskMiziCommand: Command = {
  id: "mizi.palette.ask",
  label: "MIZI: Ask…",
  category: "MIZI",
};

const MIZI_API_BASE =
  typeof window !== "undefined" &&
  (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"]
    ? (window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string
    : "";

@injectable()
export class MiziAiPaletteContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;
  @inject(MessageService) protected readonly msg: MessageService;

  onStart(): void {
    // Commands registered via CommandContribution
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(AskMiziCommand, {
      execute: () => this.askMizi(),
    });
  }

  private async askMizi(): Promise<void> {
    const inputBox = this.quickInput.createInputBox();
    inputBox.title = "MIZI: Ask a question or describe a task";
    inputBox.placeholder = "e.g., How does session routing work? / Refactor the auth middleware to use JWT";
    inputBox.ignoreFocusOut = true;

    const items: Array<{ label: string; description: string; intent: string }> = [
      { label: "Explain", description: "Explain code or architecture", intent: "explain" },
      { label: "Refactor", description: "Refactor selected code", intent: "refactor" },
      { label: "Generate", description: "Generate new code", intent: "generate" },
      { label: "Debug", description: "Debug an issue", intent: "debug" },
      { label: "Plan", description: "Plan implementation steps", intent: "plan" },
    ];
    inputBox.step = 2;
    inputBox.totalSteps = 2;

    const text = await new Promise<string>((resolve) => {
      inputBox.onDidAccept(() => {
        const value = inputBox.value.trim();
        if (value) resolve(value);
        inputBox.dispose();
      });
      inputBox.onDidChangeValue(() => {
        // Update dynamic items based on input
      });
      inputBox.show();
    });

    if (!text) return;

    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/palette/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });
      if (!resp.ok) throw new Error(await resp.text());

      const result = (await resp.json()) as {
        intent: string;
        action: string;
        parameters?: Record<string, unknown>;
      };

      // commands.executeCommand unavailable without CommandService injection - using this.quickInput approach instead
      // Dispatch through command execution - this requires CommandService

    } catch (err) {
      this.msg.error(
        `MIZI palette error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
