"use client"

import { useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import DocumentViewer from "@/app/components/document-viewer"
import TabMessage from "./tab-message"
import { callTool } from "@/browser/connection"
import { countLeaves, mergeValues, valueLines, type ReleaseValues, type ValuesView } from "@/lib/features/helm-releases/values"
import type { ReleaseInfo } from "@/lib/cluster/reports"

type Props = {
  releaseInfo: ReleaseInfo
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; values: ReleaseValues }

export default function ValuesTab({ releaseInfo }: Props) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [includeDefaults, setIncludeDefaults] = useState(false)

  const view: ValuesView = includeDefaults ? "merged" : "overrides"
  const { namespace, name } = releaseInfo

  useEffect(() => {
    let cancelled = false
    callTool<ReleaseValues>("get_helm_release", { namespace, name })
      .then(values => { if (!cancelled) setState({ status: "ready", values }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [namespace, name])

  if (state.status === "loading") {
    return <TabMessage>Loading values…</TabMessage>
  }

  if (state.status === "error") {
    return <TabMessage tone="error">Failed to load values: {state.message}</TabMessage>
  }

  const { values } = state
  const lines = valueLines(values, view)
  const setCount = countLeaves(values.overrides)
  const totalCount = countLeaves(mergeValues(values.defaults, values.overrides))
  const command = `helm get values ${name} -n ${namespace}${view === "merged" ? " --all" : ""}`
  const filename = view === "merged" ? `${name}-values-all.yaml` : `${name}-values.yaml`
  const staleRevision =
    releaseInfo.revision !== undefined && releaseInfo.revision !== values.revision ? releaseInfo.revision : null

  return (
    <div className="flex flex-col gap-3">
      {staleRevision !== null && (
        <p className="text-sm text-muted-foreground">
          The cluster is on revision {values.revision}. This report recorded revision {staleRevision}.
        </p>
      )}

      <DocumentViewer
        lines={lines}
        filename={filename}
        toolbar={
          <div className="flex shrink-0 items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-foreground">
              Include chart defaults
              <Switch checked={includeDefaults} onCheckedChange={setIncludeDefaults} />
            </label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {setCount} of {totalCount} values set
            </span>
          </div>
        }
        footer={
          <>
            <span>{lines.length} lines</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{command}</span>
          </>
        }
      />
    </div>
  )
}
