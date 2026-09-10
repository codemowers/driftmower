import assert from "node:assert/strict"
import { test } from "node:test"

import { formatCpu, formatGi, parseCount, parseCpuMillis, parseQuantity } from "./quantity.ts"

test("binary suffixes are powers of 1024", () => {
  assert.equal(parseQuantity("1Ki"), 1024)
  assert.equal(parseQuantity("2Gi"), 2 * 1024 ** 3)
  assert.equal(parseQuantity("256Mi"), 256 * 1024 ** 2)
  assert.equal(parseQuantity("10Gi"), 10 * 1024 ** 3)
})

test("decimal suffixes are powers of 1000 and are not confused with binary", () => {
  assert.equal(parseQuantity("1k"), 1000)
  assert.equal(parseQuantity("1G"), 1e9)
  // The whole point: 1G and 1Gi are different numbers.
  assert.notEqual(parseQuantity("1G"), parseQuantity("1Gi"))
})

test("milli and bare values parse, which is how cpu quotas are written", () => {
  assert.equal(parseQuantity("100m"), 0.1)
  assert.equal(parseQuantity("1"), 1)
  assert.equal(parseCpuMillis("100m"), 100)
  assert.equal(parseCpuMillis("1"), 1000)
  assert.equal(parseCpuMillis("1.5"), 1500)
})

test("decimals and leading-dot values parse", () => {
  assert.equal(parseQuantity("1.5Gi"), 1.5 * 1024 ** 3)
  assert.equal(parseQuantity("0.5"), 0.5)
  assert.equal(parseQuantity(".5"), 0.5)
})

test("unparseable input is null, never zero", () => {
  // Zero would silently read as "nothing used", inventing quota headroom.
  assert.equal(parseQuantity(undefined), null)
  assert.equal(parseQuantity(null), null)
  assert.equal(parseQuantity(""), null)
  assert.equal(parseQuantity("  "), null)
  assert.equal(parseQuantity("lots"), null)
  assert.equal(parseQuantity("10Gb"), null)
  assert.equal(parseQuantity("1Gi2"), null)
})

test("counts round to integers, for pods and pvc limits", () => {
  assert.equal(parseCount("50"), 50)
  assert.equal(parseCount("5"), 5)
})

test("formatting keeps whole numbers whole", () => {
  assert.equal(formatGi(10 * 1024 ** 3), "10Gi")
  assert.equal(formatGi(1.5 * 1024 ** 3), "1.5Gi")
  assert.equal(formatCpu(1000), "1")
  assert.equal(formatCpu(100), "100m")
})

test("binary and decimal suffixes are not interchangeable in either direction", () => {
  // Uppercase K is only valid with the "i": "K" alone is not a Kubernetes suffix.
  assert.equal(parseQuantity("1K"), null)
  // ...and the decimal kilo is lowercase, so "ki" is not a suffix either.
  assert.equal(parseQuantity("1ki"), null)
  assert.equal(parseQuantity("1Ki"), 1024)
  assert.equal(parseQuantity("1k"), 1000)
})
