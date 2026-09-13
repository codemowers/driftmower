import assert from "node:assert/strict"
import { test } from "node:test"

import { bearerScopeState, permittedNamespacesForBearer } from "./bearer-scope.ts"

test("a bearer caller sees only the namespaces its token claims", () => {
  const permitted = permittedNamespacesForBearer(["sandbox-foo", "sandbox-bar"], {
    claimNamespaces: ["sandbox-foo"],
  })

  assert.deepEqual(permitted, ["sandbox-foo"])
})

test("a crafted ?ns= cannot reach another tenant's namespace", () => {
  // The whole point of the filter: asking for someone else's namespace returns
  // nothing rather than their quota.
  const permitted = permittedNamespacesForBearer(["someone-elses-sandbox"], {
    claimNamespaces: ["sandbox-foo"],
  })

  assert.deepEqual(permitted, [])
})

test("a token with no namespaces claim gets no access, not all access", () => {
  // Failing open here would mean dropping the `namespaces` scope from the
  // OIDCClient silently hands every caller every namespace.
  const permitted = permittedNamespacesForBearer(["sandbox-foo"], { claimNamespaces: undefined })

  assert.deepEqual(permitted, [])
  assert.equal(bearerScopeState({ claimNamespaces: undefined }), "claim-missing")
})

test("an empty claim is distinguishable from an absent one", () => {
  // Different fixes: one is a token problem, the other an authorization answer.
  assert.equal(bearerScopeState({ claimNamespaces: [] }), "no-namespaces")
  assert.equal(bearerScopeState({ claimNamespaces: ["sandbox-foo"] }), "scoped")
})

test("asking for nothing returns nothing", () => {
  assert.deepEqual(permittedNamespacesForBearer([], { claimNamespaces: ["sandbox-foo"] }), [])
})
