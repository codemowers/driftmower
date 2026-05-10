import { backendUrl, proxyRequest } from "@/lib/api/proxy"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  return proxyRequest(req, `${backendUrl()}/analyze-cluster`)
}
