import assert from "node:assert/strict"
import { test } from "node:test"

import {
  claudeCodeTokenCommand,
  mcpQuickstarts,
  OPENCODE_REDIRECT_URI,
  type QuickstartInput,
} from "./mcp-quickstarts.ts"

const URL_ = "https://driftmower-mcp.ee-lte-1.codemowers.io/mcp"

const DEFAULT_INPUT: QuickstartInput = { mcpUrl: URL_, clientId: "cid-123" }

const find = (id: string) => {
  const entry = mcpQuickstarts(DEFAULT_INPUT).find((q) => q.id === id)
  assert.ok(entry, `${id} quickstart exists`)
  return entry
}

test("Claude Code signs in with the configured client id", () => {
  // Verified against `claude mcp add --help`.
  const [text] = find("claude-code").blocks
  assert.match(text, /^claude mcp add --transport http driftmower /)
  assert.match(text, /--client-id cid-123/)
})

test("Codex signs in with the configured client id", () => {
  // Verified against `codex mcp add --help`: the flag is --oauth-client-id.
  const [text] = find("codex").blocks
  assert.match(text, /^codex mcp add driftmower --url /)
  assert.match(text, /--oauth-client-id cid-123/)
})

test("opencode gets the client id and a redirect passmower accepts", () => {
  // Verified against opencode 1.18.21 signing in to bravo: `opencode mcp add`
  // has no client id flag, so it goes in opencode.json.
  const [config, command] = find("opencode").blocks
  const server = JSON.parse(config).mcp.driftmower
  assert.deepEqual(server, {
    type: "remote",
    url: URL_,
    oauth: { clientId: "cid-123", redirectUri: OPENCODE_REDIRECT_URI },
  })
  // passmower matches the path exactly; opencode's default path is refused.
  assert.equal(new URL(OPENCODE_REDIRECT_URI).pathname, "/callback")
  assert.equal(command, "opencode mcp auth driftmower")
})

test("no recipe carries a token or a header", () => {
  for (const quickstart of mcpQuickstarts(DEFAULT_INPUT)) {
    for (const block of quickstart.blocks) {
      assert.doesNotMatch(block, /--header|Bearer|token/i)
    }
  }
})

test("shell commands stand on one line", () => {
  // These get pasted by people on Windows too, where a trailing backslash
  // breaks, so each command stands on one line. Only a config file spans more.
  for (const quickstart of mcpQuickstarts(DEFAULT_INPUT)) {
    for (const block of quickstart.blocks) {
      if (block.startsWith("{")) continue
      assert.doesNotMatch(block, /\n/)
    }
  }
})

test("the token route's command passes the token as a literal header", () => {
  const text = claudeCodeTokenCommand({ mcpUrl: URL_, token: "tok-abc" })
  assert.match(text, /^claude mcp add --transport http driftmower /)
  assert.match(text, /--header "Authorization: Bearer tok-abc"/)
})
