"use client"

import { useState } from "react"
import { Activity, RotateCcw, X } from "lucide-react"
import { setInspecting, useInspector, type InspectedRequest } from "@/lib/features/inspector/store"
import { callTool, fetchMcp } from "./connection"
import { usePathname, useSearchParams } from "./navigation"
import { formatBytes } from "@/lib/utils/format-bytes"
import { cn } from "@/lib/utils/cn"

function replay(r: InspectedRequest) {
  if (r.kind === "tool") return callTool(r.name, r.args ?? {}).catch(() => {})
  return fetchMcp(r.name, { method: r.method, body: r.body, headers: r.body ? { "Content-Type": "application/json" } : undefined }).catch(() => {})
}

function Row({ r }: { r: InspectedRequest }) {
  const failed = r.status === "error" || (r.status !== undefined && r.status !== "ok" && Number(r.status) >= 400)
  return <details className="border-b last:border-0">
    <summary className="flex cursor-pointer items-center gap-3 px-4 py-2 text-xs hover:bg-muted">
      <span className={cn("w-10 shrink-0 font-mono", failed ? "text-status-major-label" : "text-muted-foreground")}>{r.status ?? "…"}</span>
      <span className="w-10 shrink-0 font-mono text-muted-foreground">{r.kind === "tool" ? "tool" : r.method}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{r.name}</span>
      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{r.bytes !== undefined ? formatBytes(r.bytes) : ""}</span>
      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{r.durationMs !== undefined ? `${Math.round(r.durationMs)} ms` : ""}</span>
      <button type="button" title="Run again" onClick={e => { e.preventDefault(); void replay(r) }} className="shrink-0 rounded p-1 hover:bg-gray-200"><RotateCcw className="size-3.5" /></button>
    </summary>
    <div className="space-y-2 bg-muted/40 px-4 py-3">
      {(r.args || r.body) && <><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Request</p><pre className="max-h-48 overflow-auto rounded bg-white p-2 font-mono text-[11px]">{r.args ? JSON.stringify(r.args, null, 2) : r.body}</pre></>}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Response</p>
      <pre className="max-h-96 overflow-auto rounded bg-white p-2 font-mono text-[11px]">{r.error ?? (r.response === undefined ? "Pending" : typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2))}</pre>
    </div>
  </details>
}

// Lists the MCP requests this page made: tool calls and HTTP reads.
export default function RequestInspector() {
  const { enabled, open, requests } = useInspector()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const page = pathname + (search ? `?${search}` : "")
  const [allPages, setAllPages] = useState(false)
  const shown = allPages ? requests : requests.filter(r => r.page === page)
  const total = shown.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  return <>
    <button type="button" title={enabled ? "Show requests" : "Inspect requests (reloads the page)"} aria-label="Request inspector"
      onClick={() => enabled ? useInspector.setState({ open: !open }) : setInspecting(true)}
      className={cn("fixed right-4 top-16 z-40 rounded-lg border bg-white p-2 shadow-sm hover:bg-muted", enabled ? "text-brand-text" : "text-muted-foreground")}>
      <Activity className="size-5" aria-hidden />
    </button>
    {enabled && open && <aside className="fixed bottom-4 right-4 top-28 z-40 flex w-[min(44rem,calc(100vw-2rem))] flex-col rounded-xl border bg-white shadow-xl">
      <header className="flex items-center gap-3 border-b px-4 py-3 text-sm">
        <span className="font-semibold">Requests</span>
        <span className="text-xs tabular-nums text-muted-foreground">{shown.length} · {formatBytes(total)}</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={allPages} onChange={e => setAllPages(e.target.checked)} />All pages</label>
        <button type="button" onClick={() => useInspector.setState({ requests: [] })} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
        <button type="button" onClick={() => setInspecting(false)} className="text-xs text-muted-foreground hover:text-foreground">Stop recording</button>
        <button type="button" aria-label="Close" onClick={() => useInspector.setState({ open: false })} className="rounded p-1 hover:bg-muted"><X className="size-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{shown.length ? [...shown].reverse().map(r => <Row key={r.id} r={r} />) : <p className="p-4 text-sm text-muted-foreground">No requests recorded on this page yet.</p>}</div>
    </aside>}
  </>
}
