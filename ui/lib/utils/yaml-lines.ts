export type YamlLine = { text: string; path: string; depth: number }

const INDENT = "  "
const PLAIN_SCALAR = /^[A-Za-z0-9._/][A-Za-z0-9._/ :@-]*$/
const AMBIGUOUS_SCALAR = /^(true|false|null|yes|no|on|off|~|[+-]?[\d.].*)$/i
const PLAIN_KEY = /^[A-Za-z0-9_-]+$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object"
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value !== "string") return String(value)
  const plain =
    value !== "" &&
    PLAIN_SCALAR.test(value) &&
    !AMBIGUOUS_SCALAR.test(value) &&
    !value.endsWith(" ") &&
    !value.endsWith(":") &&
    !value.includes(": ") &&
    !value.includes(" #")
  return plain ? value : JSON.stringify(value)
}

function keySegment(parentPath: string, key: string): string {
  if (PLAIN_KEY.test(key)) return parentPath ? `${parentPath}.${key}` : key
  return `${parentPath}[${JSON.stringify(key)}]`
}

function itemSegment(parentPath: string, item: unknown, index: number): string {
  const mergeName = isPlainObject(item) && typeof item.name === "string" ? item.name : null
  return `${parentPath}[${mergeName ?? index}]`
}

function emitObject(obj: Record<string, unknown>, path: string, depth: number, lines: YamlLine[]): void {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    const childPath = keySegment(path, key)
    const pad = INDENT.repeat(depth)
    if (isScalar(value)) {
      lines.push({ text: `${pad}${key}: ${scalarText(value)}`, path: childPath, depth })
    } else if (Array.isArray(value) && value.length === 0) {
      lines.push({ text: `${pad}${key}: []`, path: childPath, depth })
    } else if (isPlainObject(value) && Object.keys(value).length === 0) {
      lines.push({ text: `${pad}${key}: {}`, path: childPath, depth })
    } else {
      lines.push({ text: `${pad}${key}:`, path: childPath, depth })
      emitValue(value, childPath, depth + 1, lines)
    }
  }
}

function emitArray(items: unknown[], path: string, depth: number, lines: YamlLine[]): void {
  const pad = INDENT.repeat(depth)
  for (const [index, item] of items.entries()) {
    const childPath = itemSegment(path, item, index)
    if (isScalar(item)) {
      lines.push({ text: `${pad}- ${scalarText(item)}`, path: childPath, depth })
      continue
    }
    const start = lines.length
    emitValue(item, childPath, depth + 1, lines)
    if (lines.length > start) {
      const first = lines[start]
      lines[start] = { ...first, text: `${pad}- ${first.text.trimStart()}` }
    } else {
      lines.push({ text: `${pad}- ${Array.isArray(item) ? "[]" : "{}"}`, path: childPath, depth })
    }
  }
}

function emitValue(value: unknown, path: string, depth: number, lines: YamlLine[]): void {
  if (Array.isArray(value)) {
    emitArray(value, path, depth, lines)
  } else if (isPlainObject(value)) {
    emitObject(value, path, depth, lines)
  }
}

export function emitYamlLines(resource: Record<string, unknown>): YamlLine[] {
  const lines: YamlLine[] = []
  emitObject(resource, "", 0, lines)
  return lines
}

export function yamlText(lines: YamlLine[]): string {
  return lines.map(l => l.text).join("\n") + "\n"
}
