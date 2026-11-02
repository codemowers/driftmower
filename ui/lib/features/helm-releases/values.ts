import { emitYamlLines, type YamlAnnotation, type YamlLine } from "@/lib/features/yaml/yaml-lines"

export type ReleaseIdentity = {
  name: string
  namespace: string
  revision: number
  status: string
  chartName: string
  chartVersion: string
  chartAppVersion: string
}

export type ReleaseValues = ReleaseIdentity & {
  overrides: Record<string, unknown>
  defaults: Record<string, unknown>
}

export type ValuesView = "overrides" | "merged"

type Lookup = { found: boolean; value: unknown }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

export function mergeValues(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...defaults }
  for (const [key, value] of Object.entries(overrides)) {
    const base = defaults[key]
    merged[key] = isPlainObject(base) && isPlainObject(value) ? mergeValues(base, value) : value
  }
  return merged
}

function lookup(root: Record<string, unknown>, keys: (string | number)[]): Lookup {
  let current: unknown = root
  for (const key of keys) {
    if (isPlainObject(current) && typeof key === "string" && key in current) {
      current = current[key]
    } else if (Array.isArray(current) && typeof key === "number" && key < current.length) {
      current = current[key]
    } else {
      return { found: false, value: undefined }
    }
  }
  return { found: true, value: current }
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.length} items]`
  if (isPlainObject(value)) return Object.keys(value).length === 0 ? "{}" : "{…}"
  if (typeof value === "string") return value === "" ? '""' : value
  return String(value)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmptyContainer(a) && isEmptyContainer(b)) return Array.isArray(a) === Array.isArray(b)
  return a === b
}

function isDescendant(keys: (string | number)[], prefix: (string | number)[]): boolean {
  return keys.length > prefix.length && prefix.every((key, i) => keys[i] === key)
}

export function countLeaves(value: unknown): number {
  if (Array.isArray(value)) return value.length === 0 ? 1 : value.reduce<number>((n, item) => n + countLeaves(item), 0)
  if (isPlainObject(value)) {
    const entries = Object.values(value)
    return entries.length === 0 ? 1 : entries.reduce<number>((n, item) => n + countLeaves(item), 0)
  }
  return 1
}

export function valueLines(values: ReleaseValues, view: ValuesView): YamlLine[] {
  const { overrides, defaults } = values
  const document = view === "overrides" ? overrides : mergeValues(defaults, overrides)
  let wholesale: (string | number)[] | null = null

  function annotate(
    _path: string,
    keys: (string | number)[],
    value: unknown,
    isLeaf: boolean,
  ): YamlAnnotation | null {
    if (wholesale && isDescendant(keys, wholesale)) return { tone: "set" }
    wholesale = null

    if (!lookup(overrides, keys).found) return null

    const fallback = lookup(defaults, keys)

    if (!fallback.found) {
      if (!isLeaf) wholesale = keys
      return { tone: "set", note: "not in chart defaults" }
    }

    if (isLeaf) {
      if (sameValue(fallback.value, value)) return null
      return { tone: "set", note: `chart default: ${describe(fallback.value)}` }
    }

    if (isEmptyContainer(fallback.value)) {
      wholesale = keys
      return { tone: "set", note: `chart default: ${describe(fallback.value)}` }
    }

    return null
  }

  return emitYamlLines(document, { annotate, pathStyle: "helm" })
}
