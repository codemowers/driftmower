import { TriangleAlert } from "lucide-react"
import type { Claim } from "@/lib/features/volumes/types"
import { resizeStatus } from "@/lib/features/volumes/resize-status"

export default function VolumeResizeStatus({ claim }: { claim: Claim }) {
  const status = resizeStatus(claim)
  if (!status) return null
  return <div className={`mt-1 text-xs ${status.warning ? "text-amber-700" : "text-muted-foreground"}`}>
    <span className="inline-flex items-center gap-1 font-medium">
      {status.warning && <TriangleAlert className="size-3.5 shrink-0" aria-label="Resize warning" />}
      {status.label}{claim.requestedStorage && ` → ${claim.requestedStorage}`}
    </span>
    <p className="max-w-lg break-words">{status.message}</p>
  </div>
}
