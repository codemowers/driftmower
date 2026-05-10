import { explorerUrl, proxyRequest } from "@/lib/api/proxy"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  return proxyRequest(req, `${explorerUrl()}/api/resources`)
}
