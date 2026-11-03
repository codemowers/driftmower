import { backendUrl, proxyRequest } from "@/lib/server/backend-proxy"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return proxyRequest(req, `${backendUrl()}/kubernetes-contexts`)
}
