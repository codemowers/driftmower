import { proxyRequest } from "@/lib/server/backend-proxy"
import { getOidcRuntimeConfig } from "@/lib/auth/oidc"

export const dynamic = "force-dynamic"

// passmower's launcher list: the apps the calling user can access, requires
// the `applications` scope on the bearer token.
export async function GET(req: Request) {
  const issuer = getOidcRuntimeConfig().issuer.replace(/\/+$/, "")
  return proxyRequest(req, `${issuer}/api/apps`)
}
