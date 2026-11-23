import { kubectlCommand, type KubeconfigConnection } from "../../kubernetes/contexts.ts"
import { shellQuote } from "../../utils/shell.ts"
import { parseQuantity } from "./quantity.ts"
import type { VolumeDetail, Volumes } from "./types.ts"

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

// Render only unmounted claims and PVs without a current claim. Pod-list
// failures make PVC usage unknown, so those claims never get delete commands.
export function volumeCleanupCommands(volumes: Volumes, connection?: KubeconfigConnection) {
  const pvByName = new Map(volumes.persistentVolumes.map(pv => [pv.name, pv]))
  const claimNames = new Set(volumes.claims.map(claim => `${claim.namespace}/${claim.name}`))
  const boundPVs = new Set(volumes.claims.flatMap(claim => claim.boundVolume ? [claim.boundVolume] : []))
  const podsUnknown = volumes.degraded.some(item => /pods/i.test(item.source))
  const comment = (name: string, created: string | null | undefined, size: string | null, policy: string | null) =>
    `# ${name} | created ${created || "unknown"} | size ${size || "unknown"} | reclaim ${policy || "unknown"}`.replace(/[\r\n]/g, " ")
  const pvc = volumes.claims.filter(claim => !podsUnknown && claim.usedBy.length === 0)
    .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
    .map(claim => {
      const pv = claim.boundVolume ? pvByName.get(claim.boundVolume) : undefined
      const policy = pv?.reclaimPolicy ?? volumes.storageClasses.find(item => item.name === claim.storageClass)?.reclaimPolicy ?? null
      return `${comment(`${claim.namespace}/${claim.name}`, claim.createdAt, claim.provisionedStorage ?? claim.requestedStorage, policy)}\n${kubectlCommand("delete", connection, claim.namespace)} pvc ${shellQuote(claim.name)} --ignore-not-found`
    }).join("\n\n")
  const pv = volumes.persistentVolumes.filter(pv => !boundPVs.has(pv.name) &&
    (!pv.claim || pv.phase === "Released" && !claimNames.has(`${pv.claim.namespace}/${pv.claim.name}`)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(pv => `${comment(pv.claim ? `${pv.claim.namespace}/${pv.claim.name} | pv ${pv.name}` : `pv ${pv.name}`, pv.createdAt, pv.capacityStorage, pv.reclaimPolicy)}\n${kubectlCommand("delete", connection)} pv ${shellQuote(pv.name)} --ignore-not-found`).join("\n\n")
  return { pvc: pvc || "# No unused PVCs with verified Pod usage.", pv: pv || "# No unclaimed PVs." }
}
