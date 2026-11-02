import assert from "node:assert/strict"
import { test } from "node:test"

import { readVerdict, seesClusterWideViews, writeVerdict, type ScopeLike } from "./scope-rules.ts"

const ok = (namespaces: string[], admin = false): ScopeLike => ({ state: "ok", admin, namespaces })

function readable(scope: ScopeLike): Set<string> | null {
  const verdict = readVerdict(scope)
  assert.ok(verdict.allow)
  return verdict.namespaces
}

test("a scoped user is confined to their own namespaces", () => {
  const permitted = readable(ok(["sandbox-a"]))
  assert.ok(permitted)
  assert.equal(permitted.has("sandbox-a"), true)
  assert.equal(permitted.has("sandbox-b"), false)
})

test("an admin is not narrowed", () => {
  assert.equal(readable(ok(["sandbox-a"], true)), null)
})

test("a cluster without a tenancy control plane is not narrowed", () => {
  assert.equal(readable({ state: "not-configured" }), null)
})

test("a scoped user with no namespaces is permitted nothing, not everything", () => {
  const permitted = readable(ok([]))
  assert.ok(permitted)
  assert.equal(permitted.has("sandbox-a"), false)
})

test("reads are refused when scope could not be determined", () => {
  const expected = { unreachable: 503, "no-session": 401, rejected: 403 } as const
  for (const [state, status] of Object.entries(expected) as [keyof typeof expected, number][]) {
    const verdict = readVerdict({ state })
    assert.equal(verdict.allow, false, state)
    assert.equal(verdict.allow === false && verdict.status, status, state)
  }
})

test("writes are refused when scope could not be determined", () => {
  for (const state of ["unreachable", "no-session", "rejected"] as const) {
    assert.equal(writeVerdict({ state }, "kube-system").allow, false, state)
  }
})

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

test("a sandbox user does not see cluster-scoped pages", () => {
  assert.equal(seesClusterWideViews(ok(["sandbox-a"])), false)
  assert.equal(seesClusterWideViews(ok([])), false)
})

test("an admin and a single-tenant cluster see cluster-scoped pages", () => {
  assert.equal(seesClusterWideViews(ok(["sandbox-a"], true)), true)
  assert.equal(seesClusterWideViews({ state: "not-configured" }), true)
})

test("cluster-scoped pages are hidden when scope could not be determined", () => {
  for (const state of ["unreachable", "no-session", "rejected"] as const) {
    assert.equal(seesClusterWideViews({ state }), false, state)
  }
})
