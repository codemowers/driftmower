import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

export function llmBaseUrl(): string | null {
  return process.env.LLM_BASE_URL?.trim() || null
}

export function isLlmConfigured(): boolean {
  return llmBaseUrl() !== null
}

function createProvider(baseURL: string) {
  return createOpenAICompatible({
    name: "llama",
    baseURL,
    apiKey: process.env.OPENAI_API_KEY,
  })
}

let provider: ReturnType<typeof createProvider> | null = null

export function llamaModel(id: string) {
  const baseURL = llmBaseUrl()

  if (!baseURL) {
    throw new Error("LLM_BASE_URL is not set")
  }

  provider ??= createProvider(baseURL)

  return provider(id)
}
