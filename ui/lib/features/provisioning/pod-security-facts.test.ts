import assert from "node:assert/strict"
import { test } from "node:test"

import { podSecurityFor } from "./pod-security-facts.ts"

test("a restricted namespace reports the four fields the apiserver demands", () => {
  // Quoted from a live denial: a plain container in an enforce=restricted
  // sandbox is rejected for exactly these four.
  const fact = podSecurityFor({ "pod-security.kubernetes.io/enforce": "restricted" })
  assert.equal(fact?.enforce, "restricted")
  assert.deepEqual(fact?.requires, [
    "securityContext.runAsNonRoot=true",
    "securityContext.allowPrivilegeEscalation=false",
    'securityContext.capabilities.drop=["ALL"]',
    'securityContext.seccompProfile.type="RuntimeDefault"',
  ])
  assert.match(fact?.summary ?? "", /cannot run as root/)
})

test("baseline allows root, and says so rather than implying otherwise", () => {
  const fact = podSecurityFor({ "pod-security.kubernetes.io/enforce": "baseline" })
  assert.equal(fact?.enforce, "baseline")
  assert.deepEqual(fact?.requires, [])
  assert.match(fact?.summary ?? "", /running as root is allowed/)
})

test("privileged enforces nothing", () => {
  const fact = podSecurityFor({ "pod-security.kubernetes.io/enforce": "privileged" })
  assert.equal(fact?.enforce, "privileged")
  assert.match(fact?.summary ?? "", /No pod security level/)
})

test("an unlabelled namespace reports nothing rather than guessing a level", () => {
  assert.equal(podSecurityFor(undefined), null)
  assert.equal(podSecurityFor({}), null)
  assert.equal(podSecurityFor({ "pod-security.kubernetes.io/enforce": "" }), null)
  // An unrecognised value must not be reported as if it were understood.
  assert.equal(podSecurityFor({ "pod-security.kubernetes.io/enforce": "weird" }), null)
})

test("the warn and audit labels are ignored: only enforce blocks", () => {
  const fact = podSecurityFor({ "pod-security.kubernetes.io/warn": "restricted" })
  assert.equal(fact, null)
})
