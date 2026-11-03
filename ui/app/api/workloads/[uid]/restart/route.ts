import { z } from "zod"

import { getSession } from "@/lib/auth/session"
import { errorResponse } from "@/lib/server/error-response"
import { isInCluster } from "@/lib/server/k8s"
import { RestartError, restartTopmostOwner } from "@/lib/server/restart-workload"
import { guardNamespace } from "@/lib/server/sandbox-scope-filter"

export const dynamic = "force-dynamic"

const bodySchema = z.object({
  kind: z.string().min(1),
  namespace: z.string().min(1),
  name: z.string().min(1),
  managerKind: z.enum(["argo", "standalone"]),
})

export async function POST(req: Request, { params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params
  if (!isInCluster()) {
    return Response.json({ error: "Kubernetes API not reachable outside the cluster" }, { status: 503 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return Response.json({ error: "invalid restart request" }, { status: 400 })

  const denied = await guardNamespace(parsed.data.namespace)
  if (denied) return denied

  const session = await getSession()
  const actor = session.claims?.email ?? session.claims?.sub ?? "unknown"
  const { managerKind, ...target } = parsed.data

  try {
    await restartTopmostOwner({ ...target, uid }, managerKind, actor)
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    if (e instanceof RestartError) return Response.json({ error: e.message }, { status: e.status })
    return errorResponse(e, "workload-restart", `${target.kind} ${target.namespace}/${target.name}`)
  }
}
