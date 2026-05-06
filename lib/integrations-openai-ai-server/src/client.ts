import OpenAI from "openai";

const nimKey = process.env.NVIDIA_NIM_API_KEY;
const openaiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const openaiBase = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

const apiKey = nimKey || openaiKey;
const baseURL = nimKey
  ? "https://integrate.api.nvidia.com/v1"
  : openaiBase;

if (!apiKey || !baseURL) {
  throw new Error(
    "No AI provider configured. Set NVIDIA_NIM_API_KEY (recommended) or " +
    "AI_INTEGRATIONS_OPENAI_API_KEY + AI_INTEGRATIONS_OPENAI_BASE_URL.",
  );
}

export const openai = new OpenAI({ apiKey, baseURL });
