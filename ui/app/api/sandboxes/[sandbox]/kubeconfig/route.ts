import { proxyPlatformManagerRequest, SANDBOXES_PATH } from "@/lib/server/platform-manager-proxy"

export const dynamic = "force-dynamic"

// OIDC (kubelogin) kubeconfig for one sandbox, passed through as
// application/yaml text.
export async function GET(req: Request, { params }: { params: Promise<{ sandbox: string }> }) {
  const { sandbox } = await params
  return proxyPlatformManagerRequest(req, `${SANDBOXES_PATH}/${encodeURIComponent(sandbox)}/kubeconfig`)
}
