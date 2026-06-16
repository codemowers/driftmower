import { RefreshCw } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { refreshState } from "@/lib/cluster/refresh-state"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export default function Refreshbutton() {
  const { lastRefreshed, isFetchingReport } = useClusterState()

  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col items-end">
        <span className="whitespace-nowrap text-sm text-gray-400">
          {`Updated ${
            lastRefreshed != null
              ? lastRefreshed.toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                })
              : "—"
          }`}
        </span>
        {lastRefreshed != null && (
          <span className="text-xs text-gray-300">
            {lastRefreshed.toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="border-gray-200 bg-white hover:bg-gray-50"
        aria-label="Refresh"
        onClick={() => refreshState()}
      >
        <RefreshCw className={cn("size-4", isFetchingReport && "animate-spin")} aria-hidden />
      </Button>
    </div>
  )
}
