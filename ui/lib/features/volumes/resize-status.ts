import { parseQuantity } from "./quantity.ts"
import type { Claim } from "./types.ts"

export function resizeStatus(claim: Claim) {
  const conditions = (claim.conditions ?? []).filter(condition => condition.status === "True")
  const failure = conditions.find(condition => /Resize.*(Error|Failed)|ResizeInfeasible/i.test(condition.type))
  if (failure) return { warning: true, label: "Resize failed", message: failure.message || failure.type }
  if (/Failed|Infeasible|Error/.test(claim.resizeStatus ?? "")) return { warning: true, label: "Resize failed", message: claim.resizeStatus! }
  const filesystem = conditions.find(condition => condition.type === "FileSystemResizePending")
  if (filesystem) return { warning: true, label: "Filesystem resize pending", message: filesystem.message || "Waiting for the node to expand the filesystem." }
  const requested = parseQuantity(claim.requestedStorage), provisioned = parseQuantity(claim.provisionedStorage)
  if (requested !== null && provisioned !== null && requested > provisioned) {
    const resizing = conditions.find(condition => condition.type === "Resizing")
    return { warning: false, label: "Resizing", message: resizing?.message || claim.resizeStatus || "Waiting for storage expansion." }
  }
  return null
}
