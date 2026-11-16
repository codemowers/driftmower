"use client"

import { useEffect, useState } from "react"
import DocumentViewer from "@/app/components/document-viewer"
import { callTool } from "@/browser/connection"
import { emitYamlLines } from "@/lib/features/yaml/yaml-lines"

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; defaults: Record<string, unknown>; version: string }

// The chart's own values.yaml, as stored with the deployed release.
export default function ChartValuesCard({ namespace, name, chartName }: { namespace: string; name: string; chartName: string }) {
  const [state, setState] = useState<State>({ status: "loading" })
  useEffect(() => {
    let cancelled = false
    callTool<{ defaults: Record<string, unknown>; chartVersion: string }>("get_helm_release", { namespace, name })
      .then(r => { if (!cancelled) setState({ status: "ready", defaults: r.defaults, version: r.chartVersion }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [namespace, name])

  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Default values</p>
      {state.status === "loading" && <p className="text-sm text-muted-foreground">Loading values.yaml…</p>}
      {state.status === "error" && <p className="text-sm text-muted-foreground">values.yaml could not be loaded: {state.message}</p>}
      {state.status === "ready" && (
        <DocumentViewer
          lines={emitYamlLines(state.defaults)}
          filename={`${chartName}-${state.version}-values.yaml`}
          footer={<span className="font-mono">helm show values {chartName} --version {state.version}</span>}
        />
      )}
    </section>
  )
}
