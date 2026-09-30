// The resource indicator this app requests when it needs a token for
// driftmower-mcp, both for the provisioning page (which reads its facts from
// driftmower-mcp) and for the token quick start. It must equal the audience
// driftmower-mcp verifies strictly: its MCP_AUDIENCE, or its public URL + /mcp
// when that is unset. An ordinary UI session token is refused there by design.

export const DEFAULT_MCP_AUDIENCE = "https://driftmower-mcp"

export function mcpAudience(): string {
  return process.env.MCP_AUDIENCE || DEFAULT_MCP_AUDIENCE
}
