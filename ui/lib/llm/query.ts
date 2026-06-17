import { generateText, streamText } from "ai"
import { llama } from "./config"
import { MODELS, type ModelKey, type ModelSpec } from "./models"

export type QueryArgs = {
  model: ModelKey
  userPrompt: string
  systemPrompt?: string
}

function callParams({ model, userPrompt, systemPrompt }: QueryArgs) {
  const spec: ModelSpec = MODELS[model]
  return {
    model: llama(spec.id),
    system: systemPrompt,
    prompt: userPrompt,
    temperature: spec.temperature,
    maxOutputTokens: spec.maxOutputTokens,
    topP: spec.topP,
    presencePenalty: spec.presencePenalty,
  }
}

export async function query(args: QueryArgs): Promise<string> {
  const { text } = await generateText(callParams(args))
  return text
}

export function streamQuery(args: QueryArgs) {
  return streamText(callParams(args))
}
