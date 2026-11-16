import assert from "node:assert/strict"
import { test } from "node:test"
import { expandedStorage, parseQuantity } from "./quantity.ts"

test("storage quantities parse to bytes", () => {
  assert.equal(parseQuantity("8Gi"), 8 * 2 ** 30)
  assert.equal(parseQuantity("1G"), 1e9)
  assert.equal(parseQuantity("1.5Ti"), 1.5 * 2 ** 40)
  assert.equal(parseQuantity("1e9"), 1e9)
  assert.equal(parseQuantity("100"), 100)
  assert.equal(parseQuantity("bogus"), null)
  assert.equal(parseQuantity(null), null)
})

test("expansion targets round up to whole MiB in the largest exact unit", () => {
  assert.equal(expandedStorage("10Gi", 20), "12Gi")
  assert.equal(expandedStorage("10Gi", 50), "15Gi")
  assert.equal(expandedStorage("10Gi", 100), "20Gi")
  assert.equal(expandedStorage("1Gi", 20), "1229Mi")
  assert.equal(expandedStorage("1G", 20), "1145Mi")
  assert.equal(expandedStorage("512Ti", 100), "1Pi")
  assert.equal(expandedStorage("nope", 20), null)
})
