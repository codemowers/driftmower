import { generateText, streamText, type JSONValue } from "ai"
import type { z } from "zod"
import { llamaModel } from "./config"
import { MODELS, type ModelKey, type ModelSpec } from "./models"

export type QueryArgs = {
  model: ModelKey
  userPrompt: string
  systemPrompt?: string
  abortSignal?: AbortSignal
}

function callParams({ model, userPrompt, systemPrompt, abortSignal }: QueryArgs) {
  const spec: ModelSpec = MODELS[model]
  return {
    model: llamaModel(spec.id),
    system: systemPrompt,
    prompt: userPrompt,
    abortSignal,
    temperature: spec.temperature,
    maxOutputTokens: spec.maxOutputTokens,
    topP: spec.topP,
    presencePenalty: spec.presencePenalty,
    providerOptions: spec.extraBody
      ? { llama: spec.extraBody as Record<string, JSONValue> }
      : undefined,
  }
}

export async function query(args: QueryArgs): Promise<string> {
  const { text } = await generateText(callParams(args))
  return text
}

export async function queryObject<T extends z.ZodType>(args: QueryArgs & { schema: T }): Promise<z.infer<T>> {
  const text = await query(args)
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("model returned no JSON object")
  return args.schema.parse(JSON.parse(text.slice(start, end + 1)))
}

export function streamQuery(args: QueryArgs) {
  return streamText(callParams(args))
}
