import assert from "node:assert/strict"
import { test } from "node:test"

import { availabilityOf, isOfferable, type OperatorHealth } from "./availability.ts"

const healthy: OperatorHealth = {
  deployment: "cnpg-cloudnative-pg",
  namespace: "cnpg-system",
  readyReplicas: 1,
  desiredReplicas: 1,
  version: "1.24.1",
  watchedNamespaces: "all",
}

test("no CRD means not installed, and the card links somewhere useful", () => {
  const availability = availabilityOf(false, null, "https://cloudnative-pg.io/")
  assert.equal(availability.state, "not-installed")
  assert.equal(availability.state === "not-installed" && availability.installHref, "https://cloudnative-pg.io/")
})

test("a missing controller is reported, because that failure is silent", () => {
  const availability = availabilityOf(true, null, null)
  assert.equal(availability.state, "crds-only")
  // The user must learn that the apply will appear to work.
  assert.match(availability.state === "crds-only" ? availability.reason : "", /would succeed/)
})

test("zero ready replicas is degraded, and names the deployment", () => {
  const availability = availabilityOf(true, { ...healthy, readyReplicas: 0 }, null)
  assert.equal(availability.state, "degraded")
  assert.match(availability.state === "degraded" ? availability.reason : "", /cnpg-system\/cnpg-cloudnative-pg/)
  assert.match(availability.state === "degraded" ? availability.reason : "", /0\/1 pods ready/)
})

test("a running controller is ready and carries its version", () => {
  const availability = availabilityOf(true, healthy, null)
  assert.equal(availability.state, "ready")
  assert.equal(availability.state === "ready" && availability.version, "1.24.1")
})

test("only ready and degraded can be planned against", () => {
  assert.equal(isOfferable(availabilityOf(true, healthy, null)), true)
  // Degraded is offerable on purpose: the manifest is still correct, and the
  // user may well be about to fix the operator.
  assert.equal(isOfferable(availabilityOf(true, { ...healthy, readyReplicas: 0 }, null)), true)
  assert.equal(isOfferable(availabilityOf(true, null, null)), false)
  assert.equal(isOfferable(availabilityOf(false, null, null)), false)
})
