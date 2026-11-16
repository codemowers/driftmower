import { kubectlCommand, type KubeconfigConnection } from "../../kubernetes/contexts.ts"
import { shellQuote } from "../../utils/shell.ts"
import { parseQuantity } from "./quantity.ts"
import type { VolumeDetail } from "./types.ts"

export function volumeCommands(detail: VolumeDetail, requestedSize: string, connection?: KubeconfigConnection) {
  const claim = detail.claim
  const pv = detail.persistentVolume
  if (claim) {
    const resource = `pvc ${shellQuote(claim.name)}`
    const get = `${kubectlCommand("get", connection, claim.namespace)} ${resource} -o yaml`
    const remove = `${kubectlCommand("delete", connection, claim.namespace)} ${resource} --ignore-not-found`
    const desired = parseQuantity(requestedSize)
    const current = Math.max(parseQuantity(claim.requestedStorage) ?? 0, parseQuantity(claim.provisionedStorage) ?? 0)
    const expandable = detail.storageClass?.allowVolumeExpansion === true
    let resize: string | undefined
    if (expandable && desired !== null && Number.isFinite(desired) && desired > current && claim.phase === "Bound") {
      const patch = { spec: { resources: { requests: { storage: requestedSize } } } }
      resize = `${kubectlCommand("patch", connection, claim.namespace)} ${resource} --type=merge -p ${shellQuote(JSON.stringify(patch))}`
    }
    return { target: "PVC" as const, get, remove, resize }
  }
  if (pv) {
    const get = `${kubectlCommand("get", connection)} pv ${shellQuote(pv.name)} -o yaml`
    const safeFallback = ["missing", "replaced", "unbound"].includes(detail.claimState)
    return { target: "PV" as const, get, remove: safeFallback ? `${kubectlCommand("delete", connection)} pv ${shellQuote(pv.name)} --ignore-not-found` : undefined, resize: undefined }
  }
  return undefined
}
