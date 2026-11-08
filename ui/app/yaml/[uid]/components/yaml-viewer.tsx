"use client"

import { useEffect, useMemo, useState } from "react"
import { Switch } from "@/components/ui/switch"
import DocumentViewer from "@/app/components/document-viewer"
import { generatedAnnotator, stripGenerated } from "@/lib/features/yaml/managed-fields"
import { useSearchParam } from "@/lib/hooks/use-search-param"
import { emitYamlLines } from "@/lib/features/yaml/yaml-lines"
import LoadingLine from "@/app/components/loading-line"
import { callTool } from "@/browser/connection"

type Props = {
  uid: string
  kind: string
  namespace: string
  name: string
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; resource: Record<string, unknown> }

export default function YamlViewer({ uid, kind, namespace, name }: Props) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [managedParam, setManagedParam] = useSearchParam("managed")

  const showManaged = managedParam === "1"
  const resource = state.status === "ready" ? state.resource : null

  useEffect(() => {
    let cancelled = false
    callTool<Record<string,unknown>>("get_workload_object",{uid,kind,namespace,name})
      .then(resource=>{if(!cancelled)setState({status:"ready",resource})})
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [uid, kind, namespace, name])

  const views = useMemo(() => {
    if (!resource) return null
    return {
      managed: emitYamlLines(resource, { annotate: generatedAnnotator }),
      clean: emitYamlLines(stripGenerated(resource)),
    }
  }, [resource])

  if (state.status === "loading") {
    return <LoadingLine loading="YAML" />
  }

  if (state.status === "error") {
    return <p className="text-sm text-status-major-label">Failed to load YAML: {state.message}</p>
  }

  if (!views) return null

  const lines = showManaged ? views.managed : views.clean
  const hiddenCount = views.managed.length - views.clean.length
  const command = `kubectl get ${kind.toLowerCase()} ${name} -n ${namespace} -o yaml`

  return (
    <DocumentViewer
      lines={lines}
      filename={`${name}.yaml`}
      toolbar={
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-semibold text-foreground">
          Show managed fields
          <Switch checked={showManaged} onCheckedChange={next => setManagedParam(next ? "1" : null)} />
        </label>
      }
      footer={
        <>
          <span>{lines.length} lines</span>
          {!showManaged && hiddenCount > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>{hiddenCount} lines hidden</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="font-mono">{command}</span>
        </>
      }
    />
  )
}
