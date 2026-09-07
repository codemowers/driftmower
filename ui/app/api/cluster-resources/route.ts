import { getClusterResources } from "@/lib/cluster-resources/resources"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(await getClusterResources())
}
