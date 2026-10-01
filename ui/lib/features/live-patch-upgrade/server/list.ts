import "server-only"

import { KubeApiError, kubeApiGet } from "@/lib/server/k8s"
import { fetchSandboxScope } from "@/lib/server/platform-manager-proxy"
import { readVerdict } from "@/lib/server/scope-rules"
import { ACTION_KEY_ANNOTATION, NAMESPACE_ANNOTATION } from "../manifest"
import type { LivePatchUpgradeListResponse, LivePatchUpgradeRecord } from "../types"
import { getLivePatchUpgradeAvailability, kubeDenial } from "./availability"
import { LivePatchUpgradeError } from "./error"
import { bindingPath, LABEL_SELECTOR, policyPath } from "./paths"

type LabelledObject = { metadata: { annotations?: Record<string, string> } }
type ObjectList = { items: LabelledObject[] }

type Listed = { items: LabelledObject[] } | { denied: string }

async function listLabelled(path: string): Promise<Listed> {
  try {
    const list = await kubeApiGet<ObjectList>(`${path}?labelSelector=${LABEL_SELECTOR}`)
    return { items: list.items ?? [] }
  } catch (e) {
    if (e instanceof KubeApiError && (e.status === 403 || e.status === 404)) return { denied: kubeDenial(e) }
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
  const scope = readVerdict(await fetchSandboxScope())
  if (!scope.allow) throw new LivePatchUpgradeError(scope.reason, scope.status)
  const availability = await getLivePatchUpgradeAvailability()
  if (!availability.version) {
    return { available: false, canWrite: false, fixes: [], blockedReason: "This cluster does not serve MutatingAdmissionPolicy" }
  }
  const [policies, bindings] = await Promise.all([listLabelled(policyPath(availability.version)), listLabelled(bindingPath(availability.version))])
  const copyOnly = (denied: string) => ({ available: true, canWrite: false, fixes: [], blockedReason: `Can't read existing temporary fixes: ${denied}` })
  if ("denied" in policies) return copyOnly(policies.denied)
  if ("denied" in bindings) return copyOnly(bindings.denied)
  const permitted = scope.namespaces
  const records = toRecords([...policies.items, ...bindings.items])
  return {
    available: true,
    canWrite: availability.canWrite,
    fixes: permitted ? records.filter(r => permitted.has(r.namespace)) : records,
    blockedReason: availability.writeBlocked,
  }
}
