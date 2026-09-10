"use client"

import { useEffect, useState } from "react"
import { Check, Copy, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import CopyButton from "../components/copy-button"

const KREW_INSTALL_URL = "https://krew.sigs.k8s.io/docs/user-guide/setup/install/"

type FetchState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; yaml: string }

const cache = new Map<string, string>()

export default function KubeconfigPanel({ sandbox }: { sandbox: string }) {
  const [state, setState] = useState<FetchState>(() => {
    const cached = cache.get(sandbox)
    return cached ? { status: "ready", yaml: cached } : { status: "loading" }
  })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (cache.has(sandbox)) return

    let cancelled = false

    fetch(`/api/sandboxes/${encodeURIComponent(sandbox)}/kubeconfig`)
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          setState({ status: "error", message: `Request failed with status ${res.status}` })
          return
        }
        const yaml = await res.text()
        if (cancelled) return
        cache.set(sandbox, yaml)
        setState({ status: "ready", yaml })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [sandbox])

  const filename = `kubeconfig-${sandbox}.yaml`
  const command = `kubectl --kubeconfig ${filename} get pods`

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
    <section className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Kubeconfig
        </h2>
        {state.status === "ready" && (
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
        )}
      </div>

      {state.status === "loading" && (
        <p className="py-6 text-sm text-muted-foreground">Loading kubeconfig…</p>
      )}

      {state.status === "error" && (
        <p className="py-6 text-sm text-status-major">
          Failed to load kubeconfig: {state.message}
        </p>
      )}

      {state.status === "ready" && (
        <>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-foreground">
            {state.yaml}
          </pre>
          <p className="text-xs text-muted-foreground">
            Needs kubectl plus the kubelogin plugin. Install{" "}
            <a
              href={KREW_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-label underline underline-offset-2"
            >
              krew
            </a>{" "}
            first, then <code className="font-mono">kubectl krew install oidc-login</code>. On
            macOS <code className="font-mono">brew install int128/kubelogin/kubelogin</code> works
            without krew.
          </p>
          <p className="text-xs text-muted-foreground">
            Download the file, then run this from the directory you saved it in:
          </p>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
            <code className="overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground">
              {command}
            </code>
            <CopyButton value={command} className="shrink-0" />
          </div>
        </>
      )}
    </section>
  )
}
