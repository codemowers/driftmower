import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { extraBodyForId } from "./models"

export function llmBaseUrl(): string {
  return process.env.LLM_BASE_URL ?? "https://llama-api.ee-lte-1.codemowers.io/v1"
}

const injectExtraBody: typeof fetch = (input, init) => {
  if (init && typeof init.body === "string") {
    const body = JSON.parse(init.body)
    const extra = typeof body.model === "string" ? extraBodyForId(body.model) : undefined
    if (extra) init = { ...init, body: JSON.stringify({ ...body, ...extra }) }
  }
  return fetch(input, init)
}

export const llama = createOpenAICompatible({
  name: "llama",
  baseURL: llmBaseUrl(),
  apiKey: process.env.OPENAI_API_KEY,
  fetch: injectExtraBody,
})
