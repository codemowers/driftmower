import "server-only"

import { getResourceObject } from "@/lib/cluster-resources/resource-object"
import { getClusterResources, RESTARTED_AT_ANNOTATION } from "@/lib/cluster-resources/resources"
import { collectOwnedPods, findWorkloadRoot } from "@/lib/cluster/workload-root"
import { KubeApiError, kubeApiRequest } from "@/lib/server/k8s"
import { podPath, workloadPath } from "@/lib/features/live-patch-upgrade/server/paths"

const STRATEGIC_MERGE_PATCH = "application/strategic-merge-patch+json"

export type WorkloadRef = { namespace: string; kind: string; name: string; uid: string }

export async function ignoreNotFound(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (e) {
    if (e instanceof KubeApiError && e.status === 404) return
    throw e
  }
}

async function patchRestartAnnotation(path: string): Promise<void> {
  const body = { spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: new Date().toISOString() } } } } }
  await kubeApiRequest("PATCH", path, { body, contentType: STRATEGIC_MERGE_PATCH })
}

async function deleteOwnedPods(target: WorkloadRef): Promise<void> {
  const resources = await getClusterResources()
  const rootUid = findWorkloadRoot(resources, target)?.uid ?? target.uid
  for (const pod of collectOwnedPods(resources, rootUid)) {
    await ignoreNotFound(() => kubeApiRequest("DELETE", podPath(pod.namespace, pod.name)))
  }
}

export async function restartWorkload(target: WorkloadRef, managerKind: string): Promise<void> {
  const path = managerKind === "argo" ? null : workloadPath(target.kind, target.namespace, target.name)
  if (path) await patchRestartAnnotation(path)
  else await deleteOwnedPods(target)
}

const RESTARTABLE_KINDS = new Set(["Deployment", "StatefulSet"])

export class RestartError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "RestartError"
    this.status = status
  }
}

export function workloadRestartEnabled(): boolean {
  return process.env.WORKLOAD_RESTART_ENABLED === "true"
}

type OwnedObject = { metadata?: { uid?: string; ownerReferences?: { kind: string; name: string }[] } }

export async function restartTopmostOwner(target: WorkloadRef, managerKind: string, actor: string): Promise<void> {
  if (!workloadRestartEnabled()) throw new RestartError("restarting from Driftmower is turned off", 503)
  if (!RESTARTABLE_KINDS.has(target.kind)) throw new RestartError(`${target.kind} cannot be restarted from here`, 400)

  const object = (await getResourceObject(target.kind, target.namespace, target.name)) as OwnedObject | null
  if (!object || object.metadata?.uid !== target.uid) throw new RestartError(`${target.kind} ${target.namespace}/${target.name} not found`, 404)
  const owner = object.metadata?.ownerReferences?.[0]
  if (owner) throw new RestartError(`${target.kind} ${target.name} is owned by ${owner.kind} ${owner.name}, restart it through its operator`, 409)

  console.info(`[workload-restart] restart by ${actor} ${target.kind} ${target.namespace}/${target.name}`)
  await restartWorkload(target, managerKind)
}
