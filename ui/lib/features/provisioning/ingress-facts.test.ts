import assert from "node:assert/strict"
import { test } from "node:test"

import {
  hostIsAllowed,
  hostRejectionReason,
  hostRuleFor,
  suffixFromParams,
  tlsAdvice,
  toIngressClassFact,
} from "./ingress-facts.ts"

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

test("the suffix comes from the guard's own ConfigMap key", () => {
  assert.equal(suffixFromParams({ ingressDomainSuffix: "ee-lte-1.codemowers.io" }), "ee-lte-1.codemowers.io")
  // A leading dot is tolerated, since the guard prepends one itself.
  assert.equal(suffixFromParams({ ingressDomainSuffix: ".ee-lte-1.codemowers.io" }), "ee-lte-1.codemowers.io")
  assert.equal(suffixFromParams({}), null)
  assert.equal(suffixFromParams(undefined), null)
  assert.equal(suffixFromParams({ ingressDomainSuffix: "  " }), null)
})

test("ingress classes report their controller and default flag", () => {
  const fact = toIngressClassFact({
    metadata: { name: "traefik", annotations: { "ingressclass.kubernetes.io/is-default-class": "true" } },
    spec: { controller: "traefik.io/ingress-controller" },
  })
  assert.deepEqual(fact, { name: "traefik", controller: "traefik.io/ingress-controller", isDefault: true })
  assert.equal(toIngressClassFact({ spec: { controller: "x" } }), null)
})

test("TLS advice distinguishes a shared wildcard from a per-host certificate", () => {
  assert.match(tlsAdvice(["letsencrypt"], true), /needs no tls block/)
  assert.match(tlsAdvice(["letsencrypt"], false), /letsencrypt ClusterIssuer/)
  assert.match(tlsAdvice([], false), /not automatic/)
})
