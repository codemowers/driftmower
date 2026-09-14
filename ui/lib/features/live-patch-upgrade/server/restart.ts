import "server-only"

import { getClusterResources } from "@/lib/cluster-resources/resources"
import { collectOwnedPods, findWorkloadRoot } from "@/lib/cluster/workload-root"
import { KubeApiError, kubeApiRequest } from "@/lib/server/k8s"
import type { LivePatchUpgradeTarget } from "../types"
import { podPath, workloadPath } from "./paths"

const RESTART_ANNOTATION = "kubectl.kubernetes.io/restartedAt"
const STRATEGIC_MERGE_PATCH = "application/strategic-merge-patch+json"

export async function ignoreNotFound(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (e) {
    if (e instanceof KubeApiError && e.status === 404) return
    throw e
  }
}

async function patchRestartAnnotation(path: string): Promise<void> {
  const body = { spec: { template: { metadata: { annotations: { [RESTART_ANNOTATION]: new Date().toISOString() } } } } }
  await kubeApiRequest("PATCH", path, { body, contentType: STRATEGIC_MERGE_PATCH })
}

async function deleteOwnedPods(target: LivePatchUpgradeTarget): Promise<void> {
  const resources = await getClusterResources()
  const rootUid = findWorkloadRoot(resources, target)?.uid ?? target.uid
  for (const pod of collectOwnedPods(resources, rootUid)) {
    await ignoreNotFound(() => kubeApiRequest("DELETE", podPath(pod.namespace, pod.name)))
  }
}

export async function restartWorkload(target: LivePatchUpgradeTarget, managerKind: string): Promise<void> {
  const path = managerKind === "argo" ? null : workloadPath(target.kind, target.namespace, target.name)
  if (path) await patchRestartAnnotation(path)
  else await deleteOwnedPods(target)
}
