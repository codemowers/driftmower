// Connection recipes for the driftmower MCP gateway, one per client.
//
// Pure and relative-import only, like the rest of this directory: the test
// runner strips types with Node and does not resolve the `@/*` alias. The
// commands are the whole point of the panel, so they are built here and tested
// rather than assembled inline in JSX.
//
// Every recipe below was checked against the real client, not guessed. The
// page offers only the OAuth flow: the client signs in against the
// `driftmower-mcp` OIDC client itself and refreshes its own token, so nothing
// is pasted and nothing expires in an hour.

export type McpClientId = "claude-code" | "codex" | "opencode"

export type Quickstart = {
  id: McpClientId
  // "Claude Code" — names the client, so a reader scanning for their own finds
  // it without reading the command first.
  heading: string
  // Rendered above the blocks when the recipe needs one line of explanation.
  caption?: string
  // Each is copied on its own: a command to run, or a file's contents.
  blocks: string[]
}

export const SERVER_NAME = "driftmower"

// opencode's own default is http://127.0.0.1:19876/mcp/oauth/callback, and
// passmower matches the redirect path exactly, so its sign-in is refused unless
// the path is the `/callback` the OIDCClient registers. The port is ignored for
// a `native` client's loopback redirect; this one is the registered one anyway.
// opencode's callback server listens on whatever port and path this names.
export const OPENCODE_REDIRECT_URI = "http://127.0.0.1:33418/callback"

export type QuickstartInput = {
  // Full endpoint, ending in /mcp.
  mcpUrl: string
  // The public `driftmower-mcp` OIDC client. Required: passmower has no
  // dynamic client registration, so no client can discover it at runtime.
  clientId: string
}

export function mcpQuickstarts({ mcpUrl, clientId }: QuickstartInput): Quickstart[] {
  return [
    {
      id: "claude-code",
      heading: "Claude Code",
      blocks: [`claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} --client-id ${clientId}`],
    },
    {
      id: "codex",
      heading: "Codex",
      blocks: [`codex mcp add ${SERVER_NAME} --url ${mcpUrl} --oauth-client-id ${clientId}`],
    },
    {
      id: "opencode",
      heading: "opencode",
      // `opencode mcp add` takes only --url and --header, so the client id has
      // to go in the config file.
      caption: "Add this to opencode.json, then sign in. Its CLI cannot take a client id.",
      blocks: [
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: {
              [SERVER_NAME]: {
                type: "remote",
                url: mcpUrl,
                oauth: { clientId, redirectUri: OPENCODE_REDIRECT_URI },
              },
            },
          },
          null,
          2,
        ),
        `opencode mcp auth ${SERVER_NAME}`,
      ],
    },
  ]
}

// The paste-a-token command /api/mcp/token returns alongside a freshly minted
// token, for someone fetching one with curl. The page no longer offers this
// path; it lives here so the route's command is tested with the others.
export function claudeCodeTokenCommand({ mcpUrl, token }: { mcpUrl: string; token: string }): string {
  return `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} --header "Authorization: Bearer ${token}"`
}
