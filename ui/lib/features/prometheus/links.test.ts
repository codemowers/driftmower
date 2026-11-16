import assert from "node:assert/strict"
import { test } from "node:test"
import { prometheusGraphLink } from "./links.ts"

test("graph links carry one panel per expression", () => {
  const url = new URL(prometheusGraphLink("http://prom.example/", ["up", 'sum(x{a="b"})'], "1w"))
  assert.equal(url.origin + url.pathname, "http://prom.example/graph")
  assert.equal(url.searchParams.get("g0.expr"), "up")
  assert.equal(url.searchParams.get("g1.expr"), 'sum(x{a="b"})')
  assert.equal(url.searchParams.get("g1.range_input"), "1w")
})
