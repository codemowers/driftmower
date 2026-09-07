import { proxyPlatformManagerRequest } from "@/lib/server/platform-manager-proxy"

export const dynamic = "force-dynamic"

// OIDC (kubelogin) kubeconfig for one tenant, passed through as
// application/yaml text.
export async function GET(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params
  return proxyPlatformManagerRequest(req, `/api/tenants/${encodeURIComponent(tenant)}/kubeconfig`)
}
