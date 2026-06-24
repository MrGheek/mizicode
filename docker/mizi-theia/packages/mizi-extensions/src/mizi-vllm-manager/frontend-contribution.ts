import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { CommandContribution, CommandRegistry, Command } from "@theia/core/lib/common/command";
import { MessageService } from "@theia/core/lib/common/message-service";

const MIZI_API_BASE =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)["__MIZI_API_BASE"] as string) || ""
    : "";

export interface VLLMStatus {
  pid: number | null;
  status: "running" | "stopped" | "error";
  model: string | null;
  gpuUtilization: number;
  memoryUsedMb: number;
  uptime: number;
}

export const StartVLLMCommand: Command = { id: "mizi.vllm.start", label: "MIZI: Start vLLM" };
export const StopVLLMCommand: Command = { id: "mizi.vllm.stop", label: "MIZI: Stop vLLM" };

@injectable()
export class MiziVLLMFrontendContribution implements FrontendApplicationContribution, CommandContribution {
  @inject(MessageService) protected readonly msg: MessageService;

  private _status: VLLMStatus | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  get status(): VLLMStatus | null { return this._status; }

  @postConstruct()
  protected init(): void {
    this.poll();
  }

  onStart(): void {
    this.intervalHandle = setInterval(() => this.poll(), 30_000);
  }

  onStop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(StartVLLMCommand, {
      execute: async () => {
        try {
          const resp = await fetch(`${MIZI_API_BASE}/api/vllm/start`, { method: "POST" });
          if (resp.ok) { this.msg.info("vLLM started"); this.poll(); }
          else { this.msg.error(`vLLM start failed: ${await resp.text()}`); }
        } catch (err) {
          this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
    commands.registerCommand(StopVLLMCommand, {
      execute: async () => {
        try {
          const resp = await fetch(`${MIZI_API_BASE}/api/vllm/stop`, { method: "POST" });
          if (resp.ok) { this.msg.info("vLLM stopped"); this.poll(); }
          else { this.msg.error(`vLLM stop failed: ${await resp.text()}`); }
        } catch (err) {
          this.msg.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/vllm/status`);
      if (resp.ok) this._status = (await resp.json()) as VLLMStatus;
    } catch { this._status = null; }
  }
}
