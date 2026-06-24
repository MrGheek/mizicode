import { injectable, inject } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";
import { QuickInputService } from "@theia/core/lib/browser";

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

export const RunSwarmCommand: Command = { id: "mizi.swarm.run", label: "MIZI: Run Swarm Job", category: "MIZI Swarm" };
export const ListSwarmJobsCommand: Command = { id: "mizi.swarm.list", label: "MIZI: List Swarm Jobs", category: "MIZI Swarm" };
export const StopSwarmJobCommand: Command = { id: "mizi.swarm.stop", label: "MIZI: Stop Swarm Job", category: "MIZI Swarm" };

@injectable()
export class MiziClawRunnerFrontendContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(MessageService) protected readonly msg: MessageService;
  @inject(QuickInputService) protected readonly quickInput: QuickInputService;

  onStart(): void {}

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(RunSwarmCommand, { execute: () => this.runSwarm() });
    commands.registerCommand(ListSwarmJobsCommand, { execute: () => this.listJobs() });
    commands.registerCommand(StopSwarmJobCommand, { execute: () => this.stopJob() });
  }

  private async runSwarm(): Promise<void> {
    const input = this.quickInput.createInputBox();
    input.title = "Run MIZI Swarm Job";
    input.placeholder = "Describe what the swarm should do…";
    input.step = 1;
    input.totalSteps = 1;
    const prompt = await new Promise<string>((resolve) => {
      input.onDidAccept(() => { resolve(input.value.trim()); input.dispose(); });
      input.show();
    });
    if (!prompt) return;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, maxTurns: 10 }),
      });
      if (resp.ok) {
        const job = await resp.json() as { jobId: string };
        this.msg.info(`Swarm job started: ${job.jobId}`);
      } else {
        this.msg.error(`Failed: ${await resp.text()}`);
      }
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async listJobs(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/jobs`);
      if (!resp.ok) return;
      const jobs = await resp.json() as Array<{ jobId: string; status: string; prompt: string }>;
      const items = jobs.map((j) => ({
        label: j.jobId.substring(0, 8),
        description: j.status,
        detail: j.prompt.substring(0, 80),
      }));
      await this.quickInput.pick(items, { placeHolder: "Swarm jobs" });
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async stopJob(): Promise<void> {
    const input = this.quickInput.createInputBox();
    input.title = "Stop Swarm Job";
    input.placeholder = "Job ID";
    const jobId = await new Promise<string>((resolve) => {
      input.onDidAccept(() => { resolve(input.value.trim()); input.dispose(); });
      input.show();
    });
    if (!jobId) return;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/swarm/stop/${jobId}`, { method: "POST" });
      if (resp.ok) this.msg.info(`Job ${jobId} stopped`);
      else this.msg.error(`Failed: ${await resp.text()}`);
    } catch (err) {
      this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
