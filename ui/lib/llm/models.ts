export type ModelSpec = {
  id: string
  label: string
  temperature?: number
  maxOutputTokens?: number
  topP?: number
  presencePenalty?: number
  extraBody?: Record<string, unknown>
}

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
