import assert from "node:assert/strict"
import { test } from "node:test"

import { hostIsAllowed, hostRejectionReason, hostRuleFor, suffixFromAppBaseUrl } from "./ingress-facts.ts"

// A real sandbox id: the hash prefix is assigned at creation, so a user cannot
// guess it and therefore cannot guess their own hostname.
const RULE = hostRuleFor("ee-lte-1.codemowers.io", "a1b2c3-demo", "sandbox-ingress-guard")

test("the rule spells out both hostnames the guard accepts", () => {
  assert.equal(RULE.exactHost, "a1b2c3-demo.ee-lte-1.codemowers.io")
  assert.equal(RULE.labelledPattern, "a1b2c3-demo-<label>.ee-lte-1.codemowers.io")
})

test("the exact host and a single-label host are allowed", () => {
  assert.equal(hostIsAllowed("a1b2c3-demo.ee-lte-1.codemowers.io", RULE), true)
  assert.equal(hostIsAllowed("a1b2c3-demo-api.ee-lte-1.codemowers.io", RULE), true)
  // The <id>-prom convention the sandbox Prometheus UI uses.
  assert.equal(hostIsAllowed("a1b2c3-demo-prom.ee-lte-1.codemowers.io", RULE), true)
})

test("a host not anchored on the sandbox id is rejected", () => {
  assert.equal(hostIsAllowed("myapp.ee-lte-1.codemowers.io", RULE), false)
  // Another tenant's namespace — the whole reason the guard exists.
  assert.equal(hostIsAllowed("z9y8x7-other.ee-lte-1.codemowers.io", RULE), false)
  // The platform's own hostname.
  assert.equal(hostIsAllowed("driftmower-ui.ee-lte-1.codemowers.io", RULE), false)
})

test("wildcards are rejected, and the reason says why", () => {
  assert.equal(hostIsAllowed("*.ee-lte-1.codemowers.io", RULE), false)
  assert.match(hostRejectionReason("*.ee-lte-1.codemowers.io", RULE) ?? "", /shared/)
})

test("an extra dot in the label is rejected, matching the guard's CEL", () => {
  // The guard checks the middle segment contains no ".", which is what stops
  // `<id>-foo.bar.<suffix>` smuggling in a new subdomain level.
  assert.equal(hostIsAllowed("a1b2c3-demo-foo.bar.ee-lte-1.codemowers.io", RULE), false)
})

test("the id as a bare prefix with nothing after the dash is rejected", () => {
  assert.equal(hostIsAllowed("a1b2c3-demo-.ee-lte-1.codemowers.io", RULE), false)
})

test("a different suffix is rejected even with the right id", () => {
  assert.equal(hostIsAllowed("a1b2c3-demo.ee-west-1.codemowers.io", RULE), false)
})

test("an allowed host has no rejection reason", () => {
  assert.equal(hostRejectionReason("a1b2c3-demo-api.ee-lte-1.codemowers.io", RULE), null)
})

test("the suffix derives from the app's own URL, matching the guard on real clusters", () => {
  // Both verified against the live sandbox-guard-params ConfigMap.
  assert.equal(
    suffixFromAppBaseUrl("https://driftmower.aws-us-west-2-bravo.codemowers.io"),
    "aws-us-west-2-bravo.codemowers.io",
  )
  assert.equal(suffixFromAppBaseUrl("https://driftmower-dev.veebkolm.eu"), "veebkolm.eu")
})

test("derivation tolerates paths, ports and trailing slashes", () => {
  assert.equal(suffixFromAppBaseUrl("https://app.example.com/"), "example.com")
  assert.equal(suffixFromAppBaseUrl("https://app.example.com:8443"), "example.com")
  assert.equal(suffixFromAppBaseUrl("http://app.example.com/base"), "example.com")
})

test("derivation refuses when dropping a label would leave no domain", () => {
  // An apex deployment has no suffix to offer, and guessing "com" would be worse
  // than saying nothing.
  assert.equal(suffixFromAppBaseUrl("https://example.com"), null)
  assert.equal(suffixFromAppBaseUrl("https://localhost:3000"), null)
  assert.equal(suffixFromAppBaseUrl("not a url"), null)
  assert.equal(suffixFromAppBaseUrl(undefined), null)
  assert.equal(suffixFromAppBaseUrl(""), null)
})

// Parity with the apiserver, not just with my reading of the CEL. Each case
// below was submitted to a real sandbox-ingress-guard as a non-exempt sandbox
// owner (kubectl create --dry-run=server, sandbox abc123-demo, suffix
// veebkolm.eu) and the verdict recorded. If hostIsAllowed ever diverges, the
// page starts promising hostnames admission will reject.
test("hostIsAllowed matches what the guard actually decided", () => {
  const rule = hostRuleFor("veebkolm.eu", "abc123-demo", "sandbox-ingress-guard")

  const observed: [string, boolean][] = [
    ["abc123-demo.veebkolm.eu", true],
    ["abc123-demo-api.veebkolm.eu", true],
    ["myapp.veebkolm.eu", false],
    ["*.veebkolm.eu", false],
    ["abc123-demo-a.b.veebkolm.eu", false],
    // Another tenant's sandbox — the reason the guard exists.
    ["536389-mint.veebkolm.eu", false],
    ["abc123-demo.example.com", false],
  ]

  for (const [host, allowed] of observed) {
    assert.equal(hostIsAllowed(host, rule), allowed, `${host} should be ${allowed ? "allowed" : "denied"}`)
  }
})
