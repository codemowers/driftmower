import assert from "node:assert/strict"
import { test } from "node:test"

import { managerNamespace } from "../actions/types.ts"

// The object a live-patch request reaches is named from a hash of the manager
// facts, while authorization is decided on target.namespace. These tests pin the
// helper the request parser uses to notice when the two disagree.

test("each namespaced manager kind reports its namespace", () => {
  assert.equal(managerNamespace({ kind: "helm", namespace: "sandbox-a" }), "sandbox-a")
  assert.equal(managerNamespace({ kind: "standalone", namespace: "sandbox-a" }), "sandbox-a")
  assert.equal(managerNamespace({ kind: "operator", namespace: "sandbox-a" }), "sandbox-a")
})

// argo names an Application, not a namespace, so its key carries none and two
// sandboxes can hash to the same cluster-scoped object name. Nothing here can
// catch that -- the ownership annotation on the object is what does.
test("argo reports no namespace", () => {
  assert.equal(managerNamespace({ kind: "argo" }), null)
})

test("a missing or non-string namespace is not silently treated as a match", () => {
  assert.equal(managerNamespace({ kind: "helm" }), null)
  assert.equal(managerNamespace({ kind: "helm", namespace: 7 }), null)
  assert.equal(managerNamespace({ kind: "helm", namespace: null }), null)
})

test("the disagreement the parser rejects", () => {
  const attackerTarget = "sandbox-a"
  const victimFacts = { kind: "helm", namespace: "sandbox-b" }
  assert.notEqual(managerNamespace(victimFacts), attackerTarget)
})
