import { mcpAudience } from "@/lib/auth/mcp-audience"

// What the provisioning page needs to render the MCP connection recipes.
//
// Carries no secret: the page shows OAuth commands only, and a public client's
// id travels in every authorize URL anyway.
//
// Still behind the session gate: proxy.ts exempts only
// /api/provisioning/capabilities, and only when a bearer is present.

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export type McpConfigResponse = {
  // False when MCP_ENABLED is not "true". The page then explains rather than
  // offering commands that cannot work: without it, login never requests the
  // MCP resource and no MCP-audience token can be minted.
  enabled: boolean
  // Full endpoint ending in /mcp, or null when MCP_PUBLIC_URL is unset.
  mcpUrl: string | null
  audience: string
  // The public `driftmower-mcp` OIDC client. Null when unconfigured, and the
  // page then explains instead of offering commands — passmower has no dynamic
  // client registration, so no client can discover this itself.
  clientId: string | null
}

export async function GET() {
  const base = (process.env.MCP_PUBLIC_URL ?? "").replace(/\/+$/, "")

  const body: McpConfigResponse = {
    enabled: process.env.MCP_ENABLED === "true",
    mcpUrl: base ? `${base}/mcp` : null,
    audience: mcpAudience(),
    // A public client's id is not a secret — it travels in every authorize
    // URL. Only the id is read here; the client holds no usable secret.
    clientId: process.env.MCP_OIDC_CLIENT_ID || null,
  }

  return Response.json(body, { headers: NO_STORE })
}
