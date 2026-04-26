import { RefreshCw } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { refreshState } from "@/lib/cluster/refresh-state"
import { Button } from "@/components/ui/button"

export default function Refreshbutton() {
  const { lastRefreshed } = useClusterState()

  return (
    <div className="flex items-center gap-4">
      <span className="text-sm text-gray-400">
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
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="border-gray-200 bg-white hover:bg-gray-50"
        aria-label="Refresh"
        onClick={() => refreshState()}
      >
        <RefreshCw className="size-4" aria-hidden />
      </Button>
    </div>
  )
}
