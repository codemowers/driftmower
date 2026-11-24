import assert from "node:assert/strict"
import { test } from "node:test"
import { claimLoginRecovery, loginRecoveryKey, loginReturnKey } from "./login-recovery.ts"

function storage() {
  const entries = new Map<string, string>()
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
}

test("missing callback state starts one new login per endpoint without a redirect loop", () => {
  const store = storage()
  const error = new Error("No matching state found in storage")
  const endpoint = "https://mcp.example.test/mcp"
  store.setItem(loginReturnKey(endpoint), "/users/sample?tab=rights#namespace")
  assert.equal(claimLoginRecovery(error, endpoint, store), true)
  assert.equal(claimLoginRecovery(error, endpoint, store), false)
  assert.equal(store.getItem(loginReturnKey(endpoint)), "/users/sample?tab=rights#namespace")
  assert.equal(claimLoginRecovery(error, "https://other.example.test/mcp", store), true)
  store.removeItem(loginRecoveryKey(endpoint))
  assert.equal(claimLoginRecovery(error, endpoint, store), true)
})

test("token exchange and verification failures do not restart authentication", () => {
  const store = storage()
  for (const error of [new Error("invalid_grant"), new Error("State does not match"), new Error("Invalid issuer"), "No matching state found in storage", null]) {
    assert.equal(claimLoginRecovery(error, "https://mcp.example.test/mcp", store), false)
  }
})
