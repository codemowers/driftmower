import { test } from "node:test"
import assert from "node:assert/strict"
import { unexpandedHost } from "./hostnames.ts"

test("short single-label MCP hosts are not publicly reachable", () => {
  assert.equal(unexpandedHost("https://mcp/mcp"), true)
  assert.equal(unexpandedHost("https://mcp.driftmower.example.com/mcp"), false)
  assert.equal(unexpandedHost("http://localhost:3000/mcp"), false)
  assert.equal(unexpandedHost("http://127.0.0.1:3000/mcp"), false)
  assert.equal(unexpandedHost("http://[::1]:3000/mcp"), false)
  assert.equal(unexpandedHost("not a url"), false)
})
