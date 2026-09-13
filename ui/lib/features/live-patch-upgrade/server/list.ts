import "server-only"

import { KubeApiError, kubeApiGet } from "@/lib/server/k8s"
import { fetchSandboxScope } from "@/lib/server/platform-manager-proxy"
import { namespaceFilter } from "@/lib/server/sandbox-scope-filter"
import { ACTION_KEY_ANNOTATION, NAMESPACE_ANNOTATION } from "../manifest"
import type { LivePatchUpgradeListResponse, LivePatchUpgradeRecord } from "../types"
import { getLivePatchUpgradeAvailability } from "./availability"
import { bindingPath, LABEL_SELECTOR, policyPath } from "./paths"

type LabelledObject = { metadata: { annotations?: Record<string, string> } }
type ObjectList = { items: LabelledObject[] }

async function listLabelled(path: string): Promise<LabelledObject[] | null> {
  try {
    const list = await kubeApiGet<ObjectList>(`${path}?labelSelector=${LABEL_SELECTOR}`)
    return list.items ?? []
  } catch (e) {
    if (e instanceof KubeApiError && (e.status === 403 || e.status === 404)) return null
    throw e
  }
}

function toRecords(objects: LabelledObject[]): LivePatchUpgradeRecord[] {
  const byKey = new Map<string, LivePatchUpgradeRecord>()
  for (const { metadata } of objects) {
    const actionKey = metadata.annotations?.[ACTION_KEY_ANNOTATION]
    if (actionKey) byKey.set(actionKey, { actionKey, namespace: metadata.annotations?.[NAMESPACE_ANNOTATION] ?? "" })
  }
  return [...byKey.values()]
}

export async function listLivePatchUpgrades(): Promise<LivePatchUpgradeListResponse> {
  const [availability, scope] = await Promise.all([getLivePatchUpgradeAvailability(), fetchSandboxScope()])
  const unavailable = { available: false, canWrite: false, fixes: [] }
  if (!availability.version) return unavailable
  const [policies, bindings] = await Promise.all([listLabelled(policyPath(availability.version)), listLabelled(bindingPath(availability.version))])
  if (policies === null || bindings === null) return unavailable
  const allows = namespaceFilter(scope)
  const records = toRecords([...policies, ...bindings])
  return {
    available: true,
    canWrite: availability.canWrite,
    fixes: allows ? records.filter(r => allows(r.namespace)) : records,
  }
}
