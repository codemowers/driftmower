import { getClusterResources } from "@/lib/api/cluster-resources"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(await getClusterResources())
}
