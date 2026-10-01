import { generateText, type JSONValue } from "ai"
import type { z } from "zod"
import { llamaModel } from "./config"
import { PROVIDER_KEY, resolveSpec, type ModelKey, type ModelSpec } from "./models"

export type QueryArgs = {
  model: ModelKey
  userPrompt: string
  systemPrompt?: string
  abortSignal?: AbortSignal
}

function callParams({ model, userPrompt, systemPrompt, abortSignal }: QueryArgs) {
  const spec: ModelSpec = resolveSpec(model)
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
      ? { [PROVIDER_KEY]: spec.extraBody as Record<string, JSONValue> }
      : undefined,
  }
}

export async function query(args: QueryArgs): Promise<string> {
  const { text } = await generateText(callParams(args))
  return text
}

function parseObject<T extends z.ZodType>(text: string, schema: T): z.infer<T> {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error(`model returned no JSON object, got ${text.length} chars: ${text.slice(0, 300).replace(/\s+/g, " ")}`)
  return schema.parse(JSON.parse(text.slice(start, end + 1)))
}

export async function queryObject<T extends z.ZodType>(args: QueryArgs & { schema: T }): Promise<z.infer<T>> {
  return parseObject(await query(args), args.schema)
}

