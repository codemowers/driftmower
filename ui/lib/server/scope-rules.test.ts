import assert from "node:assert/strict"
import { test } from "node:test"

import { namespaceAllowList, writeVerdict, type ScopeLike } from "./scope-rules.ts"

const ok = (namespaces: string[], admin = false): ScopeLike => ({ state: "ok", admin, namespaces })

test("a scoped user is confined to their own namespaces", () => {
  const permitted = namespaceAllowList(ok(["sandbox-a"]))
  assert.ok(permitted)
  assert.equal(permitted.has("sandbox-a"), true)
  assert.equal(permitted.has("sandbox-b"), false)
})

test("an admin is not narrowed", () => {
  assert.equal(namespaceAllowList(ok(["sandbox-a"], true)), null)
})

// Reads stay deliberately open when scope is indeterminate: a listing that
// hides rows is worse than one that shows them.
test("the read list does not narrow when scope could not be determined", () => {
  for (const state of ["not-configured", "unreachable", "unauthenticated"] as const) {
    assert.equal(namespaceAllowList({ state }), null, state)
  }
})

test("a scoped user with no namespaces is permitted nothing, not everything", () => {
  const permitted = namespaceAllowList(ok([]))
  assert.ok(permitted)
  assert.equal(permitted.has("sandbox-a"), false)
})

// This is the finding: writes used to reuse the read rule, so an unreachable
// control plane let any signed-in user patch any namespace.
test("a write is refused when the control plane did not answer", () => {
  for (const state of ["unreachable", "unauthenticated"] as const) {
    const verdict = writeVerdict({ state }, "kube-system")
    assert.equal(verdict.allow, false, state)
    assert.equal(verdict.allow === false && verdict.status, 503)
  }
})

// ...but a cluster that runs no tenancy at all is single-tenant on purpose, and
// must keep working.
test("a write is allowed where no tenancy control plane is deployed", () => {
  assert.equal(writeVerdict({ state: "not-configured" }, "kube-system").allow, true)
})

test("a write outside your namespaces is refused, inside is allowed", () => {
  const scope = ok(["sandbox-a"])
  assert.equal(writeVerdict(scope, "sandbox-a").allow, true)

  const denied = writeVerdict(scope, "sandbox-b")
  assert.equal(denied.allow, false)
  assert.equal(denied.allow === false && denied.status, 403)
})

test("an admin may write anywhere", () => {
  assert.equal(writeVerdict(ok(["sandbox-a"], true), "kube-system").allow, true)
})
