import { CancellationToken } from "@theia/core";
import {
  LanguageModel, UserRequest,
  LanguageModelResponse, LanguageModelStreamResponsePart,
} from "@theia/ai-core";
import { ModelInfo, NIM_API_KEY, NIM_API_BASE, OLLAMA_BASE_URL } from "./mizi-nim-model-manager";

function makeMessages(req: UserRequest): Array<{ role: string; content: string }> {
  return req.messages.map((m) => ({
    role: m.actor === "ai" ? "assistant" : m.actor === "user" ? "user" : "system",
    content: m.type === "text" ? m.text : "",
  }));
}

async function* streamOpenAICompatible(
  baseUrl: string,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
): AsyncIterable<LanguageModelStreamResponsePart> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let usage: { input_tokens?: number; output_tokens?: number } = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    let buffer = decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
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
        // skip malformed chunk
      }
    }
  }

  if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
    yield { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 };
  }
}

async function* streamOllamaChat(
  ollamaBase: string,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
): AsyncIterable<LanguageModelStreamResponsePart> {
  const response = await fetch(`${ollamaBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${errBody}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const buffer = decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.message?.content) {
          yield { content: parsed.message.content };
          outputTokens += parsed.message.content.split(/\s+/).length;
        }
        if (parsed.done && parsed.prompt_eval_count) {
          inputTokens = parsed.prompt_eval_count;
          yield { input_tokens: inputTokens, output_tokens: outputTokens };
        }
      } catch {
        // skip
      }
    }
  }
}

export function createNimLanguageModel(info: ModelInfo): LanguageModel {
  return {
    id: `mizi-nim/${info.id}`,
    name: info.name || info.id,
    vendor: "NVIDIA",
    family: "NIM",
    maxInputTokens: info.contextLength || 131072,
    maxOutputTokens: 4096,
    status: { status: info.available ? "ready" : "unavailable" },
    request: async (req: UserRequest, _token?: CancellationToken): Promise<LanguageModelResponse> => {
      const messages = makeMessages(req);
      return {
        stream: streamOpenAICompatible(NIM_API_BASE, info.id, messages, NIM_API_KEY),
      };
    },
  } as LanguageModel;
}

export function createOllamaLanguageModel(info: ModelInfo): LanguageModel {
  const ollamaBase = OLLAMA_BASE_URL;
  return {
    id: `mizi-ollama/${info.id}`,
    name: info.name || info.id,
    vendor: "Ollama",
    family: "Ollama",
    maxInputTokens: info.contextLength || 8192,
    maxOutputTokens: 4096,
    status: { status: info.available ? "ready" : "unavailable" },
    request: async (req: UserRequest, _token?: CancellationToken): Promise<LanguageModelResponse> => {
      const messages = makeMessages(req);
      return {
        stream: streamOllamaChat(ollamaBase, info.id, messages),
      };
    },
  } as LanguageModel;
}

export function createLanguageModel(info: ModelInfo): LanguageModel {
  if (info.provider === "ollama") {
    return createOllamaLanguageModel(info);
  }
  return createNimLanguageModel(info);
}
