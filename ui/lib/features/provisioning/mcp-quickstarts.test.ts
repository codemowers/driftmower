import assert from "node:assert/strict"
import { test } from "node:test"

import { claudeCodeTokenCommand, mcpQuickstarts, type QuickstartInput } from "./mcp-quickstarts.ts"

const URL_ = "https://driftmower-mcp.ee-lte-1.codemowers.io/mcp"

const DEFAULT_INPUT: QuickstartInput = { mcpUrl: URL_, clientId: "cid-123" }

const find = (id: string) => {
  const entry = mcpQuickstarts(DEFAULT_INPUT).find((q) => q.id === id)
  assert.ok(entry, `${id} quickstart exists`)
  return entry
}

test("Claude Code signs in with the configured client id", () => {
  // Verified against `claude mcp add --help`.
  const text = find("claude-code").text
  assert.match(text, /^claude mcp add --transport http driftmower /)
  assert.match(text, /--client-id cid-123/)
})

test("Codex signs in with the configured client id", () => {
  // Verified against `codex mcp add --help`: the flag is --oauth-client-id.
  const text = find("codex").text
  assert.match(text, /^codex mcp add driftmower --url /)
  assert.match(text, /--oauth-client-id cid-123/)
})

test("no command carries a token or a header", () => {
  for (const quickstart of mcpQuickstarts(DEFAULT_INPUT)) {
    assert.doesNotMatch(quickstart.text, /--header|Bearer|token/i)
  }
})

test("no command relies on a line continuation", () => {
  // These get pasted by people on Windows too, where a trailing backslash
  // breaks, so each command stands on one line.
  for (const quickstart of mcpQuickstarts(DEFAULT_INPUT)) {
    assert.doesNotMatch(quickstart.text, /\n/)
  }
})

test("the token route's command passes the token as a literal header", () => {
  const text = claudeCodeTokenCommand({ mcpUrl: URL_, token: "tok-abc" })
  assert.match(text, /^claude mcp add --transport http driftmower /)
  assert.match(text, /--header "Authorization: Bearer tok-abc"/)
})
