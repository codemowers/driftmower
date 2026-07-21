"use client"

import { useEffect, useState } from "react"
import { Check, Copy, Download } from "lucide-react"
import { Button } from "@/components/ui/button"

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; yaml: string }

export default function KubeconfigPanel({ tenant }: { tenant: string }) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch(`/api/tenants/${encodeURIComponent(tenant)}/kubeconfig`)
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          setState({ status: "error", message: `Request failed with status ${res.status}` })
          return
        }
        const yaml = await res.text()
        if (!cancelled) setState({ status: "ready", yaml })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [tenant])

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading kubeconfig…</p>
  }

  if (state.status === "error") {
    return (
      <p className="text-sm text-status-major">
        Failed to load kubeconfig: {state.message}
      </p>
    )
  }

  const filename = `kubeconfig-${tenant}.yaml`

  function handleCopy() {
    if (state.status !== "ready") return
    navigator.clipboard.writeText(state.yaml)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleDownload() {
    if (state.status !== "ready") return
    const url = URL.createObjectURL(new Blob([state.yaml], { type: "application/yaml" }))
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleDownload}>
          <Download aria-hidden />
          Download
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-foreground">
        {state.yaml}
      </pre>
      <p className="text-xs text-muted-foreground">
        Requires kubectl and kubelogin (
        <code className="font-mono">kubectl krew install oidc-login</code>
        ), then use it with{" "}
        <code className="font-mono">kubectl --kubeconfig {filename} get pods</code>.
      </p>
    </div>
  )
}
