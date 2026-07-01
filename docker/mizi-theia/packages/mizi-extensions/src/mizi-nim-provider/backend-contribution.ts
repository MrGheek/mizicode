import { injectable, inject, postConstruct } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { CancellationToken } from "@theia/core";
import {
  LanguageModelRegistry, LanguageModel, UserRequest,
  LanguageModelResponse, LanguageModelStreamResponsePart
} from "@theia/ai-core";

interface ModelInfo {
  id: string;
  name: string;
  provider: "nim" | "vllm" | "openai";
  contextLength: number;
  quantization?: string;
  available: boolean;
}

const MIZI_API_BASE = process.env.MIZI_API_BASE || "";
const NIM_API_KEY = process.env.NIM_API_KEY || "";
const NIM_API_BASE = process.env.NIM_API_BASE || "https://integrate.api.nvidia.com/v1";

@injectable()
export class MiziNimProviderContribution implements BackendApplicationContribution {
  @inject(LanguageModelRegistry)
  protected readonly languageModelRegistry: LanguageModelRegistry;

  private models: ModelInfo[] = [];
  private activeModelId: string | null = null;
  private registeredModelIds = new Set<string>();

  @postConstruct()
  protected init(): void {
    this.refreshModels().catch(() => {});
  }

  onStart(): void {
    setInterval(() => this.refreshModels().catch(() => {}), 120_000);
  }

  configure(app: import("express").Application): void {
    app.get("/api/nim-models", async (_req, res) => {
      const models = await this.getModels();
      res.json(models);
    });
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
    if (!MIZI_API_BASE) return;
    try {
      const [modelsResp, activeResp] = await Promise.all([
        fetch(`${MIZI_API_BASE}/api/models`),
        fetch(`${MIZI_API_BASE}/api/session/model`),
      ]);
      if (modelsResp.ok) {
        const allModels = (await modelsResp.json()) as ModelInfo[];
        this.models = allModels.filter((m) => m.provider === "nim");
        await this.syncLanguageModels();
      }
      if (activeResp.ok) {
        const data = (await activeResp.json()) as { modelId: string };
        this.activeModelId = data.modelId;
      }
    } catch {
      // Silent
    }
  }

  private async syncLanguageModels(): Promise<void> {
    const nimModels: LanguageModel[] = this.models.map((m) => this.toLanguageModel(m));
    const newIds = new Set(nimModels.map((m) => m.id));
    const removedIds: string[] = [];
    for (const existingId of this.registeredModelIds) {
      if (!newIds.has(existingId)) removedIds.push(existingId);
    }
    if (removedIds.length > 0) {
      this.languageModelRegistry.removeLanguageModels(removedIds);
    }
    this.languageModelRegistry.addLanguageModels(nimModels);
    this.registeredModelIds = newIds;
  }

  private toLanguageModel(info: ModelInfo): LanguageModel {
    const modelId = info.id;
    const nimApiKey = NIM_API_KEY;
    const nimApiBase = NIM_API_BASE;

    return {
      id: `mizi-nim/${modelId}`,
      name: info.name || modelId,
      vendor: "NVIDIA",
      family: "NIM",
      maxInputTokens: info.contextLength || 131072,
      maxOutputTokens: 4096,
      status: { status: info.available ? "ready" : "unavailable" },
      request: async (req: UserRequest, _token?: CancellationToken): Promise<LanguageModelResponse> => {
        const messages = req.messages.map((m) => ({
          role: m.actor === "ai" ? "assistant" : m.actor === "user" ? "user" : "system",
          content: m.type === "text" ? m.text : "",
        }));

        const response = await fetch(`${nimApiBase}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${nimApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            messages,
            stream: true,
            max_tokens: 4096,
          }),
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`NIM API error ${response.status}: ${errBody}`);
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        async function* generateStream(): AsyncIterable<LanguageModelStreamResponsePart> {
          let buffer = "";
          let usage: { input_tokens?: number; output_tokens?: number } = {};

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === "data: [DONE]") continue;
              if (!trimmed.startsWith("data: ")) continue;

              try {
                const parsed = JSON.parse(trimmed.slice(6));
                const choice = parsed.choices?.[0];
                if (choice?.delta?.content) {
                  yield { content: choice.delta.content };
                }
                if (parsed.usage) {
                  usage = parsed.usage;
                }
              } catch {
                // JSON parse error — skip malformed chunk
              }
            }
          }

          if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
            yield {
              input_tokens: usage.input_tokens ?? 0,
              output_tokens: usage.output_tokens ?? 0,
            };
          }
        }

        return { stream: generateStream() };
      },
    } as LanguageModel;
  }
}
