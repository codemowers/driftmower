import { getClusterNodes } from "@/lib/api/cluster-resources/nodes"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(await getClusterNodes())
}
