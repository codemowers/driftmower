import { getClusterNodes } from "@/lib/cluster-resources/nodes"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(await getClusterNodes())
}
