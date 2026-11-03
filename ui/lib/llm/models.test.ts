import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { MODELS, llmProvider, resolveSpec } from "./models.ts"

// These read process.env, so each test restores what it touched. The runner
// shares one process across files.
const saved = { provider: process.env.LLM_PROVIDER, model: process.env.LLM_MODEL }

afterEach(() => {
  process.env.LLM_PROVIDER = saved.provider
  process.env.LLM_MODEL = saved.model
  if (saved.provider === undefined) delete process.env.LLM_PROVIDER
  if (saved.model === undefined) delete process.env.LLM_MODEL
})

test("the default provider is the self-hosted one, so existing clusters are untouched", () => {
  delete process.env.LLM_PROVIDER
  assert.equal(llmProvider(), "llama_cpp")

  delete process.env.LLM_MODEL
  const spec = resolveSpec("qwen3.6-diagnose")

  assert.deepEqual(spec, MODELS["qwen3.6-diagnose"])
})

test("anything that is not exactly openai stays on llama, rather than half-switching", () => {
  process.env.LLM_PROVIDER = "OpenAI"
  assert.equal(llmProvider(), "llama_cpp")

  process.env.LLM_PROVIDER = ""
  assert.equal(llmProvider(), "llama_cpp")
})

// This is the finding the whole change exists for: chat_template_kwargs is a
// llama.cpp extension, and OpenAI rejects unknown body parameters outright, so
// leaving it in place fails every call rather than being ignored.
test("openai drops the llama.cpp-only body parameter and keeps the JSON one", () => {
  process.env.LLM_PROVIDER = "openai"
  process.env.LLM_MODEL = "gpt-5.6-luna"

  const spec = resolveSpec("qwen3.6-classify")

  assert.deepEqual(spec.extraBody, { response_format: { type: "json_object" } })
  assert.equal("chat_template_kwargs" in (spec.extraBody ?? {}), false)
})

// Several newer OpenAI models accept only the default temperature and reject
// anything else, so the request must not carry ours.
test("openai sends no temperature", () => {
  process.env.LLM_PROVIDER = "openai"
  process.env.LLM_MODEL = "gpt-5.6-luna"

  assert.equal(resolveSpec("qwen3.6-classify").temperature, undefined)
  assert.equal(resolveSpec("qwen3.6-diagnose").temperature, undefined)
})

test("the model id comes from the environment on openai, where it is account-specific", () => {
  process.env.LLM_PROVIDER = "openai"
  process.env.LLM_MODEL = "gpt-5.6-luna"

  assert.equal(resolveSpec("qwen3.6-classify").id, "gpt-5.6-luna")
  assert.equal(resolveSpec("qwen3.6-diagnose").id, "gpt-5.6-luna")
})

test("LLM_MODEL also overrides the llama id, so a rebuilt llama-api needs no release", () => {
  process.env.LLM_PROVIDER = "llama_cpp"
  process.env.LLM_MODEL = "Qwen3.7-40B"

  const spec = resolveSpec("qwen3.6-diagnose")

  assert.equal(spec.id, "Qwen3.7-40B")
  // ...and the llama-only knobs survive the override.
  assert.equal(spec.temperature, 0)
  assert.deepEqual(spec.extraBody?.chat_template_kwargs, { enable_thinking: false })
})

test("each role keeps its own output budget across providers", () => {
  process.env.LLM_PROVIDER = "openai"
  process.env.LLM_MODEL = "gpt-5.6-luna"

  assert.equal(resolveSpec("qwen3.6-classify").maxOutputTokens, 300)
  assert.equal(resolveSpec("qwen3.6-diagnose").maxOutputTokens, 500)
})
