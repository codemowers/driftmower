import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

import { PROVIDER_KEY, configuredModelId, llmProvider } from "./models"

export function llmBaseUrl(): string | null {
  return process.env.LLM_BASE_URL?.trim() || null
}

// Why the feature is unavailable, or null when it is available. The routes
// return this verbatim, so a misconfiguration says which variable is missing
// instead of blaming LLM_BASE_URL for everything.
export function llmConfigError(): string | null {
  if (llmBaseUrl() === null) return "LLM_BASE_URL is not set"

  // On OpenAI the model id is account-specific, so there is no default worth
  // guessing. Catching it here turns it into the same clean 503 as an unset
  // base URL, rather than a 502 from the upstream on the first real call.
  if (llmProvider() === "openai" && configuredModelId() === null) {
    return "LLM_PROVIDER is openai, which requires LLM_MODEL, and LLM_MODEL is not set"
  }

  return null
}

export function isLlmConfigured(): boolean {
  return llmConfigError() === null
}

function createProvider(baseURL: string) {
  return createOpenAICompatible({
    name: PROVIDER_KEY,
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
