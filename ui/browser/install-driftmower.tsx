"use client"

import { LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import CopyButton from "@/app/components/copy-button"
import type { KubeconfigConnection } from "@/lib/kubernetes/contexts"

const POLICY = "Your organization may require new cluster workloads to go through its own process, such as a GitOps repository, change review or a platform team request. If so, use that process instead of installing from here."

// Shown on a discovered context whose API server answers but has no
// Driftmower MCP. One-click install runs the shown helm command through the
// desktop, using the credentials discovery already resolved.
export function InstallDriftmower({ connection, busy, onInstall }: { connection: KubeconfigConnection; busy: boolean; onInstall: (key: string) => Promise<void> }) {
  const offer = connection.install!
  const dialog = useRef<HTMLDialogElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  useEffect(() => { if (confirming) dialog.current?.showModal() }, [confirming])
  async function install() {
    setConfirming(false)
    setInstalling(true)
    try { await onInstall(connection.key) } finally { setInstalling(false) }
  }
  const anonymous = offer.authMode === "anonymous"
  return <div className="space-y-2 text-sm">
    <p className="text-muted-foreground">There is no Driftmower MCP to connect to. Install the Driftmower Helm chart into the <code>driftmower</code> namespace to add it.</p>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Helm command</summary>
      <div className="mt-1 flex items-start gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted p-2"><code>{offer.command}</code></pre><CopyButton value={offer.command}/></div>
      {offer.sshJump && <p className="mt-1">This context uses a desktop SSH jump host, which helm and kubectl do not use on their own; run the command where the API server is reachable, or use Install.</p>}
      {!offer.authMode && <p className="mt-1">The desktop could not tell whether this cluster has Passmower OIDC. Choose the access mode in the <a className="underline" href="https://github.com/codemowers/driftmower/blob/main/docs/deployment.md#access-modes" target="_blank" rel="noreferrer">deployment guide</a> before installing.</p>}
    </details>
    <p className="text-xs text-muted-foreground">{POLICY}</p>
    {offer.helm && offer.authMode && <button type="button" className="rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40" disabled={busy || installing} onClick={() => setConfirming(true)}>{installing ? <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden />Installing… (up to 5 minutes)</span> : "Install Driftmower…"}</button>}
    {!offer.helm && offer.authMode && <p className="text-xs text-muted-foreground">Install Helm to install from the desktop, or run the command above.</p>}
    {confirming && <dialog ref={dialog} aria-labelledby="install-driftmower-title" className="m-auto w-full max-w-lg rounded-lg border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/40" onCancel={event => { event.preventDefault(); setConfirming(false) }}>
      <div className="space-y-3 text-sm">
        <h2 id="install-driftmower-title" className="text-lg font-semibold">Install Driftmower on {connection.name}?</h2>
        <p>This runs <code>helm upgrade --install</code> with the latest Driftmower chart, creating the <code>driftmower</code> namespace if it does not exist, plus cluster-wide read RBAC for MCP.</p>
        {anonymous
          ? <p>This cluster has no Passmower OIDC, so MCP runs <strong>without login</strong> and only MCP is installed. A NetworkPolicy blocks in-cluster connections, so it is reachable only by port-forwarding: anyone allowed to port-forward to Pods in the <code>driftmower</code> namespace can read every namespace through it. Mutation tools are disabled.</p>
          : <p>This cluster has Passmower, so the chart defaults apply: OIDC login with each caller&apos;s own Kubernetes RBAC, an Ingress, the dashboard, scanner and crawlers.</p>}
        <p className="rounded border border-status-patch bg-status-patch-bg p-3 text-status-patch-label">{POLICY}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded border px-3 py-2" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="rounded border bg-foreground px-3 py-2 text-background" onClick={() => void install()}>Install</button>
        </div>
      </div>
    </dialog>}
  </div>
}
