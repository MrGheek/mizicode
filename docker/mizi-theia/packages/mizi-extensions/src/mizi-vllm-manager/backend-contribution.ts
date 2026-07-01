import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";

const MIZI_API_BASE = process.env.MIZI_API_BASE || "";

interface VLLMModel {
  id: string;
  name: string;
  contextLength: number;
  quantization: string;
  active: boolean;
  gpuMemoryMb: number;
}

interface VLLMProcessInfo {
  pid: number | null;
  status: "running" | "stopped" | "error";
  model: string | null;
  gpuUtilization: number;
  memoryUsedMb: number;
  uptime: number;
}

@injectable()
export class MiziVLLMManagerContribution implements BackendApplicationContribution {
  private processInfo: VLLMProcessInfo | null = null;

  @postConstruct()
  protected init(): void {
    this.poll().catch(() => {});
  }

  onStart(): void {
    setInterval(() => this.poll().catch(() => {}), 30_000);
  }

  async getModels(): Promise<VLLMModel[]> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/vllm/models`);
      if (resp.ok) return (await resp.json()) as VLLMModel[];
    } catch { /* ignore */ }
    return [];
  }

  async getProcessInfo(): Promise<VLLMProcessInfo | null> {
    return this.processInfo;
  }

  async startModel(modelId: string): Promise<boolean> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/vllm/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      return resp.ok;
    } catch { return false; }
  }

  async stopModel(): Promise<boolean> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/vllm/stop`, { method: "POST" });
      return resp.ok;
    } catch { return false; }
  }

  async updateContextLength(modelId: string, contextLength: number): Promise<boolean> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/vllm/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, contextLength }),
      });
      return resp.ok;
    } catch { return false; }
  }

  private async poll(): Promise<void> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/vllm/status`);
      if (resp.ok) this.processInfo = (await resp.json()) as VLLMProcessInfo;
    } catch {
      this.processInfo = null;
    }
  }
}
