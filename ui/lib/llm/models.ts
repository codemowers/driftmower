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
  "gemma4-think": {
    id: "gemma-4-26B-A4B-it-UD-Q4_K_XL",
    label: "Gemma 4 26B",
  },
  "qwen3-coder-think": {
    id: "qwen3-coder-30b-a3b-instruct-q4_k_m",
    label: "Qwen3 Coder 30B",
  },
  "qwen3.6-fast": {
    id: "Qwen3.6-35B-A3B-UD-Q4_K_M",
    label: "Qwen3.6 35B",
    temperature: 0.3,
    maxOutputTokens: 1024,
    topP: 0.9,
    presencePenalty: 0.5,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
} satisfies Record<string, ModelSpec>

export type ModelKey = keyof typeof MODELS

export function extraBodyForId(id: string): Record<string, unknown> | undefined {
  return (Object.values(MODELS) as ModelSpec[]).find(spec => spec.id === id)?.extraBody
}
