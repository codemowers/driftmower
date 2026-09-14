import "server-only"

import { getSession } from "@/lib/auth/session"
import { isInCluster } from "@/lib/server/k8s"
import { guardNamespace } from "@/lib/server/sandbox-scope-filter"
import { livePatchUpgradeRequestSchema } from "../schema"
import type { LivePatchUpgradeRequest } from "../types"
import { LivePatchUpgradeError } from "./error"

export type ParsedLivePatchUpgradeRequest = { request: LivePatchUpgradeRequest; actor: string }

export async function parseLivePatchUpgradeRequest(req: Request): Promise<ParsedLivePatchUpgradeRequest | Response> {
  if (!isInCluster()) {
    return Response.json({ error: "Kubernetes API not reachable outside the cluster" }, { status: 503 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const parsed = livePatchUpgradeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: "invalid temporary fix request" }, { status: 400 })
  }

  const denied = await guardNamespace(parsed.data.target.namespace)
  if (denied) return denied

  const session = await getSession()
  const actor = session.claims?.email ?? session.claims?.sub ?? "unknown"
  return { request: parsed.data as LivePatchUpgradeRequest, actor }
}

export function livePatchUpgradeErrorResponse(e: unknown): Response {
  const status = e instanceof LivePatchUpgradeError ? e.status : 502
  return Response.json({ error: String((e as Error).message) }, { status })
}
