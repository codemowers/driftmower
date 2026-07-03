import { backendUrl, proxyRequest } from "@/lib/api/backend-proxy"

export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return proxyRequest(req, `${backendUrl()}/reports/${encodeURIComponent(id)}`)
}
