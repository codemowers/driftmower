import assert from "node:assert/strict"
import { test } from "node:test"

import {
  claudeCodePasteCommand,
  mcpQuickstarts,
  maskSnippet,
  maskToken,
  TOKEN_ENV_VAR,
  TOKEN_PLACEHOLDER,
  type QuickstartInput,
} from "./mcp-quickstarts.ts"

const URL_ = "https://driftmower-mcp.ee-lte-1.codemowers.io/mcp"

const DEFAULT_INPUT: QuickstartInput = { mcpUrl: URL_, token: "tok-abc", clientId: "cid-123" }

const find = (id: string, input: QuickstartInput = DEFAULT_INPUT) => {
  const entry = mcpQuickstarts(input).find((q) => q.id === id)
  assert.ok(entry, `${id} quickstart exists`)
  return entry
}

test("Claude Code passes the token as a literal Authorization header", () => {
  // Verified against `claude mcp add --help`.
  const text = find("claude-code").paste[0].text
  assert.match(text, /^claude mcp add --transport http driftmower /)
  assert.match(text, /--header "Authorization: Bearer tok-abc"/)
})

test("Codex reads the token from an env var and takes no header flag", () => {
  // Verified against `codex mcp add --help`: there is no --header, only
  // --bearer-token-env-var. Emitting a header here would silently not work.
  const snippet = find("codex").paste[0]
  assert.match(snippet.text, new RegExp(`export ${TOKEN_ENV_VAR}='tok-abc'`))
  assert.match(snippet.text, new RegExp(`--bearer-token-env-var ${TOKEN_ENV_VAR}`))
  assert.doesNotMatch(snippet.text, /--header/)
  // The trap: exporting it only in the shell that runs `mcp add` is not enough.
  assert.match(snippet.caption ?? "", /wherever you run codex/)
})

test("the generic config is valid JSON in the shape clients expect", () => {
  const parsed = JSON.parse(find("other").paste[0].text)
  assert.deepEqual(parsed.mcpServers.driftmower, {
    type: "http",
    url: URL_,
    headers: { Authorization: "Bearer tok-abc" },
  })
})

test("a placeholder stands in until a token has been minted", () => {
  const withoutToken: QuickstartInput = { mcpUrl: URL_, token: null, clientId: null }
  for (const quickstart of mcpQuickstarts(withoutToken)) {
    assert.match(quickstart.paste[0].text, new RegExp(TOKEN_PLACEHOLDER))
  }
})

test("the OAuth flow is offered only when a client id is configured", () => {
  // passmower has no dynamic client registration, so neither CLI can discover
  // a client id at runtime. Offering the flow without one would be a dead end.
  assert.equal(find("claude-code", { mcpUrl: URL_, token: null, clientId: null }).oauth, null)
  assert.equal(find("codex", { mcpUrl: URL_, token: null, clientId: null }).oauth, null)

  assert.match(find("claude-code").oauth![0].text, /--client-id cid-123/)
  assert.match(find("codex").oauth![0].text, /--oauth-client-id cid-123/)
})

test("the OAuth command carries no token", () => {
  for (const id of ["claude-code", "codex"]) {
    assert.doesNotMatch(find(id).oauth![0].text, /tok-abc/)
  }
})

test("claudeCodePasteCommand matches the panel's own command", () => {
  const input: QuickstartInput = { mcpUrl: URL_, token: "tok-abc", clientId: null }
  assert.equal(claudeCodePasteCommand(input), find("claude-code", input).paste[0].text)
})

test("masking keeps a token recognisable without showing it", () => {
  const masked = maskToken("abcdef0123456789wxyz")
  assert.match(masked, /^abcdef/)
  assert.match(masked, /wxyz$/)
  assert.doesNotMatch(masked, /0123456789/)

  // A short value reveals nothing at all rather than most of itself.
  assert.equal(maskToken("short"), "•••••")
})

test("masking a snippet hides every occurrence of the token", () => {
  const text = "Bearer tok-abc and again tok-abc"
  const masked = maskSnippet(text, "tok-abc")
  assert.doesNotMatch(masked, /tok-abc/)
  assert.equal(maskSnippet(text, null), text)
})
