"use client"

import { useEffect, useState } from "react"
import DocumentViewer from "@/app/components/document-viewer"
import { emitYamlLines, type YamlLine } from "@/lib/utils/yaml-lines"

type Props = {
  uid: string
  kind: string
  namespace: string
  name: string
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; lines: YamlLine[] }

export default function YamlViewer({ uid, kind, namespace, name }: Props) {
  const [state, setState] = useState<FetchState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false
    const query = new URLSearchParams({ kind, namespace, name })

    fetch(`/api/cluster-resources/${encodeURIComponent(uid)}/yaml?${query}`, { cache: "no-store" })
      .then(async res => {
        if (cancelled) return
        const json = await res.json()
        if (!res.ok) {
          setState({ status: "error", message: json.error ?? `Request failed with status ${res.status}` })
          return
        }
        setState({ status: "ready", lines: emitYamlLines(json) })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [uid, kind, namespace, name])

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading YAML…</p>
  }

  if (state.status === "error") {
    return <p className="text-sm text-status-major-label">Failed to load YAML: {state.message}</p>
  }

  return <DocumentViewer lines={state.lines} filename={`${name}.yaml`} />
}
