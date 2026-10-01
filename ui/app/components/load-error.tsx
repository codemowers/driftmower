import { TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"

type Props = {
  message: string
  onRetry?: () => void
}

export default function LoadError({ message, onRetry }: Props) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <TriangleAlert className="size-4 shrink-0 text-status-major-label" aria-hidden />
      <p className="min-w-0 flex-1 break-words text-foreground">{message}</p>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}
