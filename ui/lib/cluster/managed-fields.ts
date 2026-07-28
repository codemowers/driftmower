import type { YamlAnnotation } from "@/lib/utils/yaml-lines"

const GENERATED_METADATA_KEYS = new Set([
  "uid",
  "resourceVersion",
  "generation",
  "creationTimestamp",
  "selfLink",
  "managedFields",
])

const GENERATED_ANNOTATIONS = new Set(["kubectl.kubernetes.io/last-applied-configuration"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isGeneratedPath(keys: (string | number)[]): boolean {
  const [leaf, parent, grandparent] = [keys.at(-1), keys.at(-2), keys.at(-3)]
  if (typeof leaf !== "string") return false
  if (parent === "metadata") return GENERATED_METADATA_KEYS.has(leaf)
  if (parent === "annotations" && grandparent === "metadata") return GENERATED_ANNOTATIONS.has(leaf)
  return false
}

export function generatedAnnotator(
  _path: string,
  keys: (string | number)[],
): YamlAnnotation | null {
  return isGeneratedPath(keys) ? { note: "server-managed" } : null
}

function stripValue(value: unknown, keys: (string | number)[]): unknown {
  if (Array.isArray(value)) return value.map((item, index) => stripValue(item, [...keys, index]))
  if (!isPlainObject(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const childKeys = [...keys, key]
    if (isGeneratedPath(childKeys)) continue
    const stripped = stripValue(child, childKeys)
    const emptiedAnnotations =
      key === "annotations" &&
      keys.at(-1) === "metadata" &&
      isPlainObject(stripped) &&
      Object.keys(stripped).length === 0
    if (emptiedAnnotations) continue
    result[key] = stripped
  }
  return result
}

export function stripGenerated(resource: Record<string, unknown>): Record<string, unknown> {
  return stripValue(resource, []) as Record<string, unknown>
}
