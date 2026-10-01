// What each role asks the model for, and how that request differs per provider.
//
// Two providers, named to match driftmower-ai's LLM_PROVIDER so one cluster
// reads the same way across both services: `llama_cpp` is the self-hosted
// llama-api and stays the default everywhere, `openai` is a canonical
// OpenAI-compatible endpoint, including OpenAI itself.
//
// They differ in more than the base URL, which is why the difference lives here
// rather than in the deployment manifest:
//
//   * The model id is fixed by the llama build but account-specific on OpenAI,
//     so there it has to come from LLM_MODEL.
//   * `chat_template_kwargs` is a llama.cpp extension. OpenAI rejects unknown
//     body parameters, so sending it would fail every call rather than be
//     ignored.
//   * `temperature` is dropped on OpenAI: several of its newer models accept
//     only the default and reject anything else. Determinism there is the
//     model's default rather than ours, which is worth knowing if a
//     classification starts drifting.

export type LlmProvider = "llama_cpp" | "openai"

export type ModelSpec = {
  id: string
  label: string
  temperature?: number
  maxOutputTokens?: number
  topP?: number
  presencePenalty?: number
  extraBody?: Record<string, unknown>
}

// Key for the AI SDK's providerOptions. It must match the name the provider is
// created with in config.ts. It is an internal label rather than a vendor name,
// so it stays put when the provider changes.
export const PROVIDER_KEY = "llama"

// The keys are roles, not model names: a caller asks for "classify", and which
// model answers is deployment configuration.
export const MODELS = {
  "qwen3.6-classify": {
    id: "Qwen3.6-35B-A3B-UD-Q4_K_M",
    label: "Qwen3.6 35B",
    temperature: 0,
    maxOutputTokens: 300,
    extraBody: {
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
    },
  },
  "qwen3.6-diagnose": {
    id: "Qwen3.6-35B-A3B-UD-Q4_K_M",
    label: "Qwen3.6 35B",
    temperature: 0,
    maxOutputTokens: 500,
    extraBody: {
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
    },
  },
} satisfies Record<string, ModelSpec>

export type ModelKey = keyof typeof MODELS

export function llmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER?.trim() === "openai" ? "openai" : "llama_cpp"
}

export function configuredModelId(): string | null {
  return process.env.LLM_MODEL?.trim() || null
}

// The spec actually sent, once the provider has had its say. Pure apart from
// the two environment reads above, which is what makes it testable.
export function resolveSpec(key: ModelKey, provider: LlmProvider = llmProvider()): ModelSpec {
  const base = MODELS[key]
  const id = configuredModelId() ?? base.id

  if (provider === "llama_cpp") return { ...base, id }

  return {
    ...base,
    id,
    temperature: undefined,
    // Keep the JSON instruction, drop the llama.cpp-only one.
    extraBody: { response_format: { type: "json_object" } },
  }
}
