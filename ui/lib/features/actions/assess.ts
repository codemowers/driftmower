import "server-only"

import type { ActionFacts, AssessResult, ChangeEntry, Classification, ConfigKey, Coverage } from "@/lib/features/actions/types"
import { deriveRisk, deriveValue, interimVersion, verdictText } from "@/lib/features/actions/verdict"
import { buildAssessPayload, callAssessPrompt } from "@/lib/llm/prompts/assess-action-version-changes"
import { getReleaseValues } from "@/lib/features/helm-releases/releases"
import { mergeValues } from "@/lib/features/helm-releases/values"
import { getResourceObject } from "@/lib/cluster-resources/resource-object"
import { resolveChangelog } from "./changelog"

const CONFIG_KEY_CAP = 80
const MIN_TOKEN_LENGTH = 4

type Inputs = { configKeys: ConfigKey[]; valuesKey: AssessResult["valuesKey"] }

function flatten(value: unknown, prefix: string, out: ConfigKey[]): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      out.push({ path: prefix, type: "object" })
      return
    }
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out)
    return
  }
  out.push({ path: prefix, type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value })
}

function findValuesKey(merged: Record<string, unknown>, repository: string, from: string): AssessResult["valuesKey"] {
  const tail = repository.split("/").slice(1).join("/")
  let tagMatch: string | null = null
  let imageMatch: string | null = null
  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return
    const obj = value as Record<string, unknown>
    const repo = obj.repository
    if (typeof repo === "string" && (repo === repository || repo === tail || repo.endsWith(`/${tail}`)) && !tagMatch) {
      tagMatch = path ? `${path}.tag` : "tag"
    }
    for (const [k, v] of Object.entries(obj)) {
      const childPath = path ? `${path}.${k}` : k
      if (typeof v === "string" && !imageMatch && (v.startsWith(`${repository}:`) || v.startsWith(`${tail}:`) || v === repository || v === tail) && v.includes(from)) {
        imageMatch = childPath
      }
      walk(v, childPath)
    }
  }
  walk(merged, "")
  if (tagMatch) return { path: tagMatch, mode: "tag" }
  if (imageMatch) return { path: imageMatch, mode: "image" }
  return null
}

async function helmInputs(namespace: string, release: string, repository: string, from: string): Promise<Inputs> {
  const values = await getReleaseValues(namespace, release)
  if (!values) return { configKeys: [], valuesKey: null }
  const configKeys: ConfigKey[] = []
  flatten(values.overrides, "", configKeys)
  const merged = mergeValues(values.defaults, values.overrides)
  return { configKeys, valuesKey: findValuesKey(merged, repository, from) }
}

async function standaloneInputs(kind: string, namespace: string, name: string): Promise<Inputs> {
  const object = await getResourceObject(kind, namespace, name)
  const spec = (object as { spec?: { template?: { spec?: { containers?: { args?: string[]; command?: string[] }[] } } } } | null)?.spec?.template?.spec
  const flags = new Set<string>()
  for (const container of spec?.containers ?? []) {
    for (const arg of [...(container.command ?? []), ...(container.args ?? [])]) {
      const match = /^(--?[A-Za-z][\w.-]*)/.exec(arg)
      if (match) flags.add(match[1])
    }
  }
  return { configKeys: [...flags].map(path => ({ path, type: "flag" })), valuesKey: null }
}

async function collectInputs(facts: ActionFacts): Promise<Inputs> {
  const manager = facts.manager
  try {
    if (manager.kind === "helm") return await helmInputs(manager.namespace, manager.release, facts.repository, facts.from)
    if (manager.kind === "standalone") return await standaloneInputs(manager.workloadKind, manager.namespace, manager.name)
  } catch (e) {
    console.warn(`[actions] inputs failed for ${facts.repository}:`, (e as Error).message)
  }
  return { configKeys: [], valuesKey: null }
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= MIN_TOKEN_LENGTH),
  )
}

export function filterConfigKeys(keys: ConfigKey[], entries: ChangeEntry[]): ConfigKey[] {
  const entryTokens = new Set<string>()
  for (const entry of entries) for (const t of tokens(entry.text)) entryTokens.add(t)
  const scored = keys
    .map(key => ({ key, hits: [...tokens(key.path)].filter(t => entryTokens.has(t)).length }))
    .filter(x => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
  return scored.slice(0, CONFIG_KEY_CAP).map(x => x.key)
}

function shouldSkipModel(facts: ActionFacts, entries: ChangeEntry[], configKeys: ConfigKey[], prekinded: boolean): boolean {
  if (facts.kind === "pin-digest") return true
  if (entries.length === 0) return true
  if (facts.drift === "patch" && configKeys.length === 0) return true
  if (prekinded && configKeys.length === 0) return true
  return false
}

function union(ordered: number[], extras: number[]): number[] {
  return [...ordered, ...extras.filter(i => !ordered.includes(i)).sort((x, y) => x - y)]
}

export async function assess(facts: ActionFacts, signal: AbortSignal): Promise<AssessResult> {
  const inputs = await collectInputs(facts)
  const changelog = await resolveChangelog(facts)
  const entries = changelog.entries
  const sentKeys = filterConfigKeys(inputs.configKeys, entries)

  let classification: Classification = { breaking: changelog.pretagBreaking, security: changelog.pretagSecurity, notable: [], affects: [] }
  const modelUsed = !shouldSkipModel(facts, entries, sentKeys, changelog.prekinded)
  if (modelUsed) {
    const payload = buildAssessPayload(facts, entries, sentKeys, { breaking: changelog.pretagBreaking, security: changelog.pretagSecurity })
    const model = await callAssessPrompt(payload, signal)
    classification = {
      breaking: union(model.breaking, changelog.pretagBreaking),
      security: union(model.security, changelog.pretagSecurity),
      notable: model.notable,
      affects: model.affects,
    }
  }

  const tagged = new Set([...classification.breaking, ...classification.security])
  const notable = classification.notable.filter(i => !tagged.has(i))
  const other = entries.map((_, i) => i).filter(i => !tagged.has(i) && !notable.includes(i))

  const coverage: Coverage = {
    changelog: changelog.source,
    versionsCovered: changelog.versionsCovered,
    versionsTotal: changelog.versionsTotal,
    modelUsed,
    configKeysTotal: inputs.configKeys.length,
    configKeysSent: sentKeys.length,
  }
  const risk = deriveRisk(facts, classification, coverage)
  const interim = interimVersion(entries, classification, facts)
  return {
    risk,
    value: deriveValue(facts, classification),
    verdict: verdictText(risk, facts, classification, coverage, interim),
    entries,
    groups: { breaking: classification.breaking, security: classification.security, notable, other },
    affects: classification.affects,
    configKeys: sentKeys,
    coverage,
    sources: changelog.sources,
    valuesKey: inputs.valuesKey,
    interim,
    chartAppVersions: changelog.chartAppVersions,
  }
}
