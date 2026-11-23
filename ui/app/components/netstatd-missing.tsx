import { Activity } from "lucide-react"

export function NetstatdMissingStatus() {
  return (
    <div className="flex items-center gap-2">
      <span className="size-2.5 shrink-0 rounded-full bg-gray-400" />
      <span className="text-sm font-medium text-muted-foreground">Not found</span>
    </div>
  )
}

export function NetstatdMissingNotice() {
  return (
    <div className="flex items-start gap-4 rounded-xl border border-gray-200 bg-white px-5 py-6">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-muted-foreground">
        <Activity className="size-6" strokeWidth={2} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-semibold text-foreground">netstatd not found</p>
        <p className="max-w-[66ch] text-sm leading-relaxed text-muted-foreground">
          Network topology reads live connections from the netstatd DaemonSet, and no running netstatd pods were found in
          this cluster. Install netstatd to see live connections here.
        </p>
      </div>
    </div>
  )
}
