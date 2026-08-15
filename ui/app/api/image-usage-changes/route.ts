import { backendUrl, proxyRequest } from "@/lib/api/backend-proxy"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return proxyRequest(req, `${backendUrl()}/image-usage-changes`)
}
