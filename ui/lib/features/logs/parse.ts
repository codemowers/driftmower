export type Severity = "fatal" | "error" | "warn" | "info" | "debug"

export type ParsedLine = {
  severity: Severity | null
  message: string
  // Remaining structured fields, without time, level and message.
  fields: [string, string][]
}

const LEVEL_KEYS = ["level", "severity", "lvl", "levelname", "log.level", "loglevel"]
const MESSAGE_KEYS = ["msg", "message", "MESSAGE", "log", "event"]
// The runtime timestamp is shown once; the line's own copy is dropped.
const TIME_KEYS = new Set(["time", "ts", "timestamp", "@timestamp", "datetime", "date", "t"])

export function normalizeSeverity(raw: unknown): Severity | null {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s) return null
  if (/^(fatal|panic|crit|critical|emerg|alert|f)$/.test(s)) return "fatal"
  if (/^(err|error|e)$/.test(s)) return "error"
  if (/^(warn|warning|w)$/.test(s)) return "warn"
  if (/^(info|information|notice|i)$/.test(s)) return "info"
  if (/^(debug|trace|verbose|d)$/.test(s)) return "debug"
  const n = Number(s)
  // Bunyan/pino numeric levels.
  if (Number.isFinite(n) && n >= 10) return n >= 60 ? "fatal" : n >= 50 ? "error" : n >= 40 ? "warn" : n >= 30 ? "info" : "debug"
  return null
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function fromRecord(record: Record<string, unknown>): ParsedLine | null {
  const levelKey = LEVEL_KEYS.find(k => k in record)
  const messageKey = MESSAGE_KEYS.find(k => typeof record[k] === "string")
  if (!levelKey && !messageKey) return null
  const fields = Object.entries(record)
    .filter(([k]) => k !== levelKey && k !== messageKey && !TIME_KEYS.has(k))
    .map(([k, v]): [string, string] => [k, text(v)])
  return { severity: levelKey ? normalizeSeverity(record[levelKey]) : null, message: messageKey ? String(record[messageKey]) : "", fields }
}

// logfmt: key=value pairs, values optionally double-quoted.
function logfmt(line: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  const re = /([\w.@-]+)=("(?:[^"\\]|\\.)*"|\S*)/g
  let match: RegExpExecArray | null
  let covered = 0
  while ((match = re.exec(line)) !== null) {
    const raw = match[2]
    out[match[1]] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw
    covered += match[0].length
  }
  // Mostly pairs, and naming a level or message.
  return covered > line.replace(/\s/g, "").length * 0.6 && ("level" in out || "msg" in out || "lvl" in out) ? out : null
}

const KLOG = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ ([^\]]+)\] ?(.*)$/
const LEADING_TIME = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s+/
const LEADING_LEVEL = /^\[?(FATAL|PANIC|CRIT(?:ICAL)?|ERROR|ERR|WARN(?:ING)?|INFO|NOTICE|DEBUG|TRACE)\]?:?\s+/i

// Splits a log line into severity, message and fields: JSON objects, logfmt,
// klog, and plain text with a leading timestamp and level.
export function parseLogLine(line: string): ParsedLine {
  const trimmed = line.trim()
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const record = JSON.parse(trimmed) as unknown
      if (record && typeof record === "object" && !Array.isArray(record)) {
        const parsed = fromRecord(record as Record<string, unknown>)
        if (parsed) return parsed
      }
    } catch { /* not JSON after all */ }
  }
  const pairs = logfmt(trimmed)
  if (pairs) {
    const parsed = fromRecord(pairs)
    if (parsed) return parsed
  }
  const klog = KLOG.exec(trimmed)
  if (klog) return { severity: normalizeSeverity(klog[1]), message: klog[3], fields: [["source", klog[2]]] }
  let rest = trimmed.replace(LEADING_TIME, "")
  const level = LEADING_LEVEL.exec(rest)
  if (level) rest = rest.slice(level[0].length)
  return { severity: level ? normalizeSeverity(level[1]) : null, message: rest, fields: [] }
}
