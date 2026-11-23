export type YamlLine = { text: string; path: string; depth: number; tone?: "set"; note?: string }

export type YamlAnnotation = { tone?: "set"; note?: string }

export type YamlAnnotator = (
  path: string,
  keys: (string | number)[],
  value: unknown,
  isLeaf: boolean,
) => YamlAnnotation | null

export type YamlPathStyle = "jsonpath" | "helm"

export type YamlLineOptions = {
  annotate?: YamlAnnotator
  pathStyle?: YamlPathStyle
}

type EmitContext = {
  lines: YamlLine[]
  annotate?: YamlAnnotator
  pathStyle: YamlPathStyle
}

const INDENT = "  "
const PLAIN_SCALAR = /^[A-Za-z0-9._/][A-Za-z0-9._/ :@-]*$/
const AMBIGUOUS_SCALAR = /^(true|false|null|yes|no|on|off|~|[+-]?[\d.].*)$/i
const PLAIN_KEY = /^[A-Za-z0-9_-]+$/
const HELM_RESERVED = /([.,])/g

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

function keySegment(parentPath: string, key: string, style: YamlPathStyle): string {
  if (style === "helm") {
    const escaped = key.replace(HELM_RESERVED, "\\$1")
    return parentPath ? `${parentPath}.${escaped}` : escaped
  }
  if (PLAIN_KEY.test(key)) return parentPath ? `${parentPath}.${key}` : key
  return `${parentPath}[${JSON.stringify(key)}]`
}

function itemSegment(parentPath: string, item: unknown, index: number, style: YamlPathStyle): string {
  if (style === "helm") return `${parentPath}[${index}]`
  const mergeName = isPlainObject(item) && typeof item.name === "string" ? item.name : null
  return `${parentPath}[${mergeName ?? index}]`
}

function pushLine(
  ctx: EmitContext,
  line: YamlLine,
  keys: (string | number)[],
  value: unknown,
  isLeaf: boolean,
): void {
  const annotation = ctx.annotate?.(line.path, keys, value, isLeaf)
  ctx.lines.push(annotation ? { ...line, ...annotation } : line)
}

function emitObject(
  obj: Record<string, unknown>,
  path: string,
  keys: (string | number)[],
  depth: number,
  ctx: EmitContext,
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    const childPath = keySegment(path, key, ctx.pathStyle)
    const childKeys = [...keys, key]
    const pad = INDENT.repeat(depth)
    if (isScalar(value)) {
      pushLine(ctx, { text: `${pad}${key}: ${scalarText(value)}`, path: childPath, depth }, childKeys, value, true)
    } else if (Array.isArray(value) && value.length === 0) {
      pushLine(ctx, { text: `${pad}${key}: []`, path: childPath, depth }, childKeys, value, true)
    } else if (isPlainObject(value) && Object.keys(value).length === 0) {
      pushLine(ctx, { text: `${pad}${key}: {}`, path: childPath, depth }, childKeys, value, true)
    } else {
      pushLine(ctx, { text: `${pad}${key}:`, path: childPath, depth }, childKeys, value, false)
      emitValue(value, childPath, childKeys, depth + 1, ctx)
    }
  }
}

function emitArray(
  items: unknown[],
  path: string,
  keys: (string | number)[],
  depth: number,
  ctx: EmitContext,
): void {
  const pad = INDENT.repeat(depth)
  for (const [index, item] of items.entries()) {
    const childPath = itemSegment(path, item, index, ctx.pathStyle)
    const childKeys = [...keys, index]
    if (isScalar(item)) {
      pushLine(ctx, { text: `${pad}- ${scalarText(item)}`, path: childPath, depth }, childKeys, item, true)
      continue
    }
    const start = ctx.lines.length
    emitValue(item, childPath, childKeys, depth + 1, ctx)
    if (ctx.lines.length > start) {
      const first = ctx.lines[start]
      ctx.lines[start] = { ...first, text: `${pad}- ${first.text.trimStart()}` }
    } else {
      pushLine(
        ctx,
        { text: `${pad}- ${Array.isArray(item) ? "[]" : "{}"}`, path: childPath, depth },
        childKeys,
        item,
        true,
      )
    }
  }
}

function emitValue(
  value: unknown,
  path: string,
  keys: (string | number)[],
  depth: number,
  ctx: EmitContext,
): void {
  if (Array.isArray(value)) {
    emitArray(value, path, keys, depth, ctx)
  } else if (isPlainObject(value)) {
    emitObject(value, path, keys, depth, ctx)
  }
}

export function emitYamlLines(resource: Record<string, unknown>, options?: YamlLineOptions): YamlLine[] {
  const ctx: EmitContext = {
    lines: [],
    annotate: options?.annotate,
    pathStyle: options?.pathStyle ?? "jsonpath",
  }
  emitObject(resource, "", [], 0, ctx)
  return ctx.lines
}

export function textLines(text: string): YamlLine[] {
  return text.split("\n").map(line => ({ text: line, path: "", depth: 0 }))
}

export function yamlText(lines: YamlLine[]): string {
  return lines.map(l => l.text).join("\n") + "\n"
}
