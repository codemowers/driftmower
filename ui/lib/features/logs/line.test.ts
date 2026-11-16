import assert from "node:assert/strict"
import test from "node:test"
import { compareNs, nsToRFC3339 } from "./line.ts"

test("nanosecond timestamps keep their full precision", () => {
  assert.equal(nsToRFC3339("1794412800123456789"), "2026-11-11T16:00:00.123456789Z")
  assert.equal(nsToRFC3339("1794412800000000001"), "2026-11-11T16:00:00.000000001Z")
})

test("nanosecond strings compare numerically", () => {
  assert.equal(compareNs("999", "1000"), -1)
  assert.equal(compareNs("1794412800123456789", "1794412800123456789"), 0)
})
