// Connection recipes for the driftmower MCP gateway, one per client.
//
// Pure and relative-import only, like the rest of this directory: the test
// runner strips types with Node and does not resolve the `@/*` alias. The
// commands are the whole point of the panel, so they are built here and tested
// rather than assembled inline in JSX.
//
// Every command below was checked against the real CLI's `--help`, not guessed.
// The page offers only the OAuth flow: the client signs in against the
// `driftmower-mcp` OIDC client itself and refreshes its own token, so nothing
// is pasted and nothing expires in an hour.

export type McpClientId = "claude-code" | "codex"

export type Snippet = {
  // "Claude Code" — names the client, so a reader scanning for their own finds
  // it without reading the command first.
  heading: string
  text: string
}

export type Quickstart = Snippet & { id: McpClientId }

export const SERVER_NAME = "driftmower"

export type QuickstartInput = {
  // Full endpoint, ending in /mcp.
  mcpUrl: string
  // The public `driftmower-mcp` OIDC client. Required: passmower has no
  // dynamic client registration, so neither CLI can discover it at runtime.
  clientId: string
}

export function mcpQuickstarts({ mcpUrl, clientId }: QuickstartInput): Quickstart[] {
  return [
    {
      id: "claude-code",
      heading: "Claude Code",
      text: `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} --client-id ${clientId}`,
    },
    {
      id: "codex",
      heading: "Codex",
      text: `codex mcp add ${SERVER_NAME} --url ${mcpUrl} --oauth-client-id ${clientId}`,
    },
  ]
}

// The paste-a-token command /api/mcp/token returns alongside a freshly minted
// token, for someone fetching one with curl. The page no longer offers this
// path; it lives here so the route's command is tested with the others.
export function claudeCodeTokenCommand({ mcpUrl, token }: { mcpUrl: string; token: string }): string {
  return `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} --header "Authorization: Bearer ${token}"`
}
