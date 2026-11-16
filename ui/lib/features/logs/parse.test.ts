import assert from "node:assert/strict"
import { test } from "node:test"
import { parseLogLine } from "./parse.ts"

test("JSON lines yield severity and message without their own time", () => {
  const p = parseLogLine('{"time":"2026-11-12T08:00:00Z","level":"WARN","msg":"watch interrupted","resource":"pods"}')
  assert.equal(p.severity, "warn")
  assert.equal(p.message, "watch interrupted")
  assert.deepEqual(p.fields, [["resource", "pods"]])
})

test("logfmt, klog and plain prefixes are understood", () => {
  assert.deepEqual(parseLogLine('time=2026-11-12T08:00:00Z level=error msg="disk full" path=/data'), { severity: "error", message: "disk full", fields: [["path", "/data"]] })
  const klog = parseLogLine('E1111 15:51:41.173654       1 reflector.go:227] "Failed to watch" err="forbidden"')
  assert.equal(klog.severity, "error")
  assert.equal(klog.message, '"Failed to watch" err="forbidden"')
  assert.deepEqual(parseLogLine("2026-11-12 08:00:00,123 INFO started on :8080"), { severity: "info", message: "started on :8080", fields: [] })
  assert.deepEqual(parseLogLine("plain text"), { severity: null, message: "plain text", fields: [] })
})

test("numeric pino levels map to severities", () => {
  assert.equal(parseLogLine('{"level":50,"msg":"boom"}').severity, "error")
})
