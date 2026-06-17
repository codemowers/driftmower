import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

export function llmBaseUrl(): string {
  return process.env.LLM_BASE_URL ?? "https://llama-api.ee-lte-1.codemowers.io/v1"
}

export const llama = createOpenAICompatible({
  name: "llama",
  baseURL: llmBaseUrl(),
  apiKey: process.env.OPENAI_API_KEY,
})
