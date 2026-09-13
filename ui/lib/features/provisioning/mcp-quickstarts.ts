// Connection recipes for the driftmower MCP gateway, one per client.
//
// Pure and relative-import only, like the rest of this directory: the test
// runner strips types with Node and does not resolve the `@/*` alias. The
// commands are the whole point of the panel, so they are built here and tested
// rather than assembled inline in JSX.
//
// Every command below was checked against the real CLI's `--help`, not guessed.
// The two differ in a way that matters: Claude Code takes the token as a
// literal header, Codex reads it from an environment variable and takes no
// header flag at all.

export type McpClientId = "claude-code" | "codex" | "other"

export type Snippet = {
  kind: "shell" | "json"
  text: string
  // Rendered above the snippet when it needs one line of explanation.
  caption?: string
}

export type Quickstart = {
  id: McpClientId
  label: string
  // Paste a token you already minted. Works today, expires in about an hour.
  paste: Snippet[]
  // Authorization code + PKCE against the `driftmower-mcp` OIDC client, which
  // refreshes itself. Null when no client id is configured, because neither CLI
  // can start the flow without one — passmower has no dynamic client
  // registration, so nothing can discover it at runtime.
  oauth: Snippet[] | null
}

export const TOKEN_PLACEHOLDER = "<paste-your-token>"
export const SERVER_NAME = "driftmower"
export const TOKEN_ENV_VAR = "DRIFTMOWER_MCP_TOKEN"

export type QuickstartInput = {
  // Full endpoint, ending in /mcp.
  mcpUrl: string
  token: string | null
  clientId: string | null
}

export function mcpQuickstarts({ mcpUrl, token, clientId }: QuickstartInput): Quickstart[] {
  const secret = token ?? TOKEN_PLACEHOLDER

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      paste: [
        {
          kind: "shell",
          text: `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} \\\n  --header "Authorization: Bearer ${secret}"`,
        },
      ],
      oauth: clientId
        ? [
            {
              kind: "shell",
              caption:
                "Omit the header and Claude Code runs the OAuth flow itself, refreshing the token as it expires.",
              text: `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl} \\\n  --client-id ${clientId}`,
            },
          ]
        : null,
    },
    {
      id: "codex",
      label: "Codex",
      paste: [
        {
          kind: "shell",
          // Codex has no --header flag: --bearer-token-env-var names an
          // environment variable it reads at connect time. Exporting it in the
          // same shell as `codex mcp add` is not enough — it has to be set
          // wherever codex actually runs, which is what the caption says.
          caption: `Codex reads the token from an environment variable rather than a header, so ${TOKEN_ENV_VAR} must be set wherever you run codex — not only when adding the server.`,
          text: `export ${TOKEN_ENV_VAR}='${secret}'\ncodex mcp add ${SERVER_NAME} --url ${mcpUrl} \\\n  --bearer-token-env-var ${TOKEN_ENV_VAR}`,
        },
      ],
      oauth: clientId
        ? [
            {
              kind: "shell",
              caption: "Codex then keeps its own token and refreshes it.",
              text: `codex mcp add ${SERVER_NAME} --url ${mcpUrl} \\\n  --oauth-client-id ${clientId}`,
            },
          ]
        : null,
    },
    {
      id: "other",
      label: "Other clients",
      paste: [
        {
          kind: "json",
          caption:
            "Most MCP clients read a config file in this shape — Cursor, Claude Desktop, VS Code and others. Check yours for where the file lives.",
          text: JSON.stringify(
            {
              mcpServers: {
                [SERVER_NAME]: {
                  type: "http",
                  url: mcpUrl,
                  headers: { Authorization: `Bearer ${secret}` },
                },
              },
            },
            null,
            2,
          ),
        },
      ],
      oauth: null,
    },
  ]
}

// The one-line command for the quick start, so the /api/mcp/token response and
// the panel cannot drift apart.
export function claudeCodePasteCommand(input: QuickstartInput): string {
  const quickstart = mcpQuickstarts(input).find(entry => entry.id === "claude-code")

  return quickstart?.paste[0]?.text ?? ""
}

// A token is a credential: show enough to tell two apart, never the whole
// thing. The copy button still carries the real value.
export function maskToken(token: string): string {
  if (token.length <= 12) return "•".repeat(token.length)

  return `${token.slice(0, 6)}${"•".repeat(24)}${token.slice(-4)}`
}

export function maskSnippet(text: string, token: string | null): string {
  if (!token) return text

  return text.split(token).join(maskToken(token))
}
