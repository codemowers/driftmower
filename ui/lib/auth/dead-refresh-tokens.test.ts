import assert from "node:assert/strict"
import { test } from "node:test"

import { createDeadTokenRegistry, DEAD_TOKEN_TTL_MS, isDeadTokenError } from "./dead-refresh-tokens.ts"

test("a marked token is dead until the TTL passes", () => {
  let clock = 1_000
  const registry = createDeadTokenRegistry(() => clock)

  assert.equal(registry.has("rt-1"), false)
  registry.mark("rt-1")
  assert.equal(registry.has("rt-1"), true)
  assert.equal(registry.has("rt-2"), false)

  clock += DEAD_TOKEN_TTL_MS
  assert.equal(registry.has("rt-1"), false)
  assert.equal(registry.size, 0)
})

test("a missing token is never dead", () => {
  assert.equal(createDeadTokenRegistry().has(undefined), false)
})

test("marking prunes expired entries", () => {
  let clock = 0
  const registry = createDeadTokenRegistry(() => clock)
  registry.mark("old")
  clock += DEAD_TOKEN_TTL_MS
  registry.mark("new")
  assert.equal(registry.size, 1)
})

test("only invalid_grant marks a token dead", () => {
  // What openid-client throws for passmower's "refresh token not found".
  assert.equal(isDeadTokenError({ error: "invalid_grant", error_description: "grant request is invalid" }), true)
  // Configuration, not a dead token: ending the session would loop sign-ins.
  assert.equal(isDeadTokenError({ error: "invalid_target" }), false)
  assert.equal(isDeadTokenError({ error: "invalid_scope" }), false)
  // The IdP being unreachable says nothing about the token.
  assert.equal(isDeadTokenError(new TypeError("fetch failed")), false)
  assert.equal(isDeadTokenError(null), false)
})
