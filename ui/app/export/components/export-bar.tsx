import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"

type Props = {
  count: number
  sizeLabel: string
  filename: string
}

export default function ExportBar({ count, sizeLabel, filename }: Props) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-6 rounded-xl border border-gray-200 bg-white px-5 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate font-mono text-sm text-foreground">{filename}</span>
        <span className="shrink-0 rounded-md bg-brand-bg px-2.5 py-1 text-xs font-semibold tabular-nums text-brand-label">
          {count} artifacts · {sizeLabel}
        </span>
      </div>

      <Button type="button" className="h-10 shrink-0 bg-brand px-5 text-sm text-white hover:bg-brand/90">
        <Download className="size-4" aria-hidden />
        Download bundle
      </Button>
    </div>
  )
}
