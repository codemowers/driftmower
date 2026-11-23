import type { Tool } from "@modelcontextprotocol/sdk/types.js"

type Schema = boolean | {
  type?: string | string[]
  $ref?: string
  anyOf?: Schema[]
  oneOf?: Schema[]
  allOf?: Schema[]
  enum?: unknown[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  additionalProperties?: Schema
  description?: string
  default?: unknown
}

export function schemaType(raw: unknown, depth = 0): string {
  const schema = raw as Schema | undefined
  if (schema === false) return "never"
  if (!schema || schema === true) return "unknown"
  if (schema.$ref) return decodeURIComponent(schema.$ref.split("/").pop() ?? schema.$ref).replaceAll("~1", "/").replaceAll("~0", "~")
  const union = schema.anyOf ?? schema.oneOf
  if (union) return [...new Set(union.map(value => schemaType(value, depth)))].join(" | ")
  if (schema.allOf) return schema.allOf.map(value => schemaType(value, depth)).join(" & ")
  if (schema.enum?.length) return schema.enum.map(value => JSON.stringify(value)).join(" | ")
  if (Array.isArray(schema.type)) return schema.type.map(type => schemaType({ ...schema, type }, depth)).join(" | ")
  if (schema.type === "array") return `Array<${schemaType(schema.items, depth + 1)}>`
  if (schema.type === "object" || schema.properties) {
    const entries = Object.entries(schema.properties ?? {})
    if (!entries.length) return `Record<string, ${schemaType(schema.additionalProperties, depth + 1)}>`
    if (depth > 0) return "object"
    const fields = entries.slice(0, 4).map(([name, value]) => `${name}${schema.required?.includes(name) ? "" : "?"}: ${schemaType(value, depth + 1)}`)
    if (entries.length > 4) fields.push("…")
    return `{ ${fields.join("; ")} }`
  }
  return schema.type ?? "unknown"
}

export function toolParameters(tool: Pick<Tool, "inputSchema">) {
  const schema = tool.inputSchema as Schema
  if (!schema || typeof schema === "boolean") return []
  return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
    name,
    type: schemaType(value),
    required: schema.required?.includes(name) ?? false,
    description: typeof value === "object" ? value.description : undefined,
    defaultValue: typeof value === "object" && value.default !== undefined ? JSON.stringify(value.default) : undefined,
  })).sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
}

export function toolSignature(tool: Pick<Tool, "name" | "inputSchema" | "outputSchema">): string {
  const parameters = toolParameters(tool).map(p => `${p.name}${p.required ? "" : "?"}: ${p.type}`).join(", ")
  return `${tool.name}(${parameters})${tool.outputSchema ? ` → ${schemaType(tool.outputSchema)}` : ""}`
}
