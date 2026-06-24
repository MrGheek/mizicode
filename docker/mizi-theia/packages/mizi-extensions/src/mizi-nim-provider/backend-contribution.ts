import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";

interface ModelInfo {
  id: string;
  name: string;
  provider: "nim" | "vllm" | "openai";
  contextLength: number;
  quantization?: string;
  available: boolean;
}

const MIZI_API_BASE = process.env.MIZI_API_BASE || "http://localhost:3000";

@injectable()
export class MiziNimProviderContribution implements BackendApplicationContribution {
  private models: ModelInfo[] = [];
  private activeModelId: string | null = null;

  @postConstruct()
  protected init(): void {
    this.refreshModels().catch(() => {});
  }

  onStart(): void {
    setInterval(() => this.refreshModels().catch(() => {}), 120_000);
  }

  async getModels(): Promise<ModelInfo[]> {
    if (this.models.length === 0) await this.refreshModels();
    return this.models;
  }

  async getActiveModel(): Promise<string | null> {
    return this.activeModelId;
  }

  async switchModel(modelId: string): Promise<boolean> {
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/session/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      if (resp.ok) {
        this.activeModelId = modelId;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async refreshModels(): Promise<void> {
    try {
      const [modelsResp, activeResp] = await Promise.all([
        fetch(`${MIZI_API_BASE}/api/models`),
        fetch(`${MIZI_API_BASE}/api/session/model`),
      ]);
      if (modelsResp.ok) this.models = (await modelsResp.json()) as ModelInfo[];
      if (activeResp.ok) {
        const data = (await activeResp.json()) as { modelId: string };
        this.activeModelId = data.modelId;
      }
    } catch {
      // Silent
    }
  }
}
