"use client"

import { LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import CopyButton from "@/app/components/copy-button"
import type { InstallOptions, KubeconfigConnection } from "@/lib/kubernetes/contexts"

const CA_HELP = <>The platform way is trust-manager distributing a <code>trusted-ca-certs</code> ConfigMap and an admission policy mounting it (see <code>workload-trusted-ca</code> in codemowers-kube). Alternatively create a ConfigMap holding a PEM bundle in the <code>driftmower</code> namespace and add <code>--set trustedCA.configMapName=&lt;name&gt;</code> to the command.</>

const POLICY = "Your organization may require new cluster workloads to go through its own process, such as a GitOps repository, change review or a platform team request. If so, use that process instead of installing from here."

function Command({ value }: { value: string }) {
  return <div className="mt-1 flex items-start gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted p-2"><code>{value}</code></pre><CopyButton value={value}/></div>
}

// Shown on a discovered context whose API server answers but has no
// Driftmower MCP. One-click install runs the shown commands through the
// desktop, using the credentials discovery already resolved. Where Pods get
// no CA bundle, an OIDC install first adds the platform's CA trust layer.
export function InstallDriftmower({ connection, busy, onInstall }: { connection: KubeconfigConnection; busy: boolean; onInstall: (key: string, options: InstallOptions) => Promise<void> }) {
  const offer = connection.install!
  const trust = offer.trust
  const nodestatd = offer.nodestatd
  const prerequisites = Boolean(trust || nodestatd)
  const dialog = useRef<HTMLDialogElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [certManager, setCertManager] = useState(false)
  useEffect(() => { if (confirming) dialog.current?.showModal() }, [confirming])
  // The operator and registry scraper keep caches on PersistentVolumes.
  const needsStorage = offer.authMode === "rbac" && !offer.defaultStorageClass
  const [storageClass, setStorageClass] = useState("")
  async function install() {
    setConfirming(false)
    setInstalling(true)
    try { await onInstall(connection.key, { storageClass: needsStorage ? storageClass : undefined, installCertManager: certManager }) } finally { setInstalling(false) }
  }
  const anonymous = offer.authMode === "anonymous"
  const ready = !trust || trust.certManager || certManager
  return <div className="space-y-2 text-sm">
    <p className="text-muted-foreground">There is no Driftmower MCP to connect to. Install the Driftmower Helm chart into the <code>driftmower</code> namespace to add it.</p>
    {trust && <p className="text-xs text-muted-foreground">Pods on this cluster get no CA certificates, and Driftmower&apos;s images contain none, so logins would fail. Install first sets up CA trust the way the codemowers platform does.</p>}
    {nodestatd && <p className="text-xs text-muted-foreground">nodestatd is not installed; Install adds it first so Driftmower has an image inventory for drift, advisories and scans.</p>}
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{prerequisites ? "Commands" : "Helm command"}</summary>
      {(trust?.commands ?? []).map(command => <Command key={command} value={command}/>)}
      {nodestatd && <Command value={nodestatd.command}/>}
      <Command value={offer.command}/>
      {offer.sshJump && <p className="mt-1">This context uses a desktop SSH jump host, which helm and kubectl do not use on their own; run the commands where the API server is reachable, or use Install.</p>}
      {!offer.authMode && <p className="mt-1">The desktop could not tell whether this cluster has Passmower OIDC. Choose the access mode in the <a className="underline" href="https://github.com/codemowers/driftmower/blob/main/docs/deployment.md#access-modes" target="_blank" rel="noreferrer">deployment guide</a> before installing.</p>}
    </details>
    <p className="text-xs text-muted-foreground">{POLICY}</p>
    {offer.helm && offer.authMode && <button type="button" className="rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40" disabled={busy || installing} onClick={() => setConfirming(true)}>{installing ? <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden />Installing… (several minutes)</span> : "Install Driftmower…"}</button>}
    {!offer.helm && offer.authMode && <p className="text-xs text-muted-foreground">Install Helm to install from the desktop, or run the commands above.</p>}
    {confirming && <dialog ref={dialog} aria-labelledby="install-driftmower-title" className="m-auto w-full max-w-lg rounded-lg border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/40" onCancel={event => { event.preventDefault(); setConfirming(false) }}>
      <div className="space-y-3 text-sm">
        <h2 id="install-driftmower-title" className="text-lg font-semibold">Install Driftmower on {connection.name}?</h2>
        {trust && <div className="space-y-2">
          <p className="font-medium">Cluster CA trust (cluster-wide)</p>
          <p>Pods here get no CA certificates. Without them MCP cannot fetch the OIDC signing keys and every login fails. This adds the platform&apos;s reusable trust layer, which other workloads can use too:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{trust.certManager ? "cert-manager: already installed." : <label className="inline-flex items-start gap-2"><input type="checkbox" className="mt-1" checked={certManager} onChange={event => setCertManager(event.target.checked)}/><span>Install cert-manager 1.20 into <code>cert-manager</code>. trust-manager requires it; it also adds cluster-wide certificate CRDs and webhooks.</span></label>}</li>
            <li>{trust.trustManager ? "trust-manager: already installed." : <>Install trust-manager 0.22 into <code>cert-manager</code>.</>}</li>
            <li>{trust.bundle ? <>Bundle <code>trusted-ca-certs</code>: already exists.</> : <>Create Bundle <code>trusted-ca-certs</code>: the public CAs as a ConfigMap with key <code>ca.pem</code> in every namespace, named as on the codemowers platform.</>}</li>
          </ul>
          <p className="text-xs text-muted-foreground">Driftmower then mounts it with <code>trustedCA.configMapName</code>. Adopting the platform&apos;s <code>workload-trusted-ca</code> admission policy later makes that setting redundant.</p>
        </div>}
        {nodestatd && <div className="space-y-2">
          <p className="font-medium">Image inventory (cluster-wide)</p>
          <p>Install nodestatd into <code>kube-system</code>: a DaemonSet on every node, including control-plane nodes, that reads the node&apos;s containerd images through its socket and records them as ContainerImage objects. Without it Driftmower shows no drift, advisories or scans.{nodestatd.k3s && <> This is k3s, so it uses k3s&apos;s containerd socket.</>}</p>
        </div>}
        {prerequisites && <p className="font-medium">Driftmower</p>}
        <p>This runs <code>helm upgrade --install</code> with the latest Driftmower chart, creating the <code>driftmower</code> namespace if it does not exist, plus cluster-wide read RBAC for MCP.</p>
        {anonymous
          ? <p>This cluster has no Passmower OIDC, so MCP runs <strong>without login</strong> and only MCP is installed. A NetworkPolicy blocks in-cluster connections, so it is reachable only by port-forwarding: anyone allowed to port-forward to Pods in the <code>driftmower</code> namespace can read every namespace through it. Mutation tools are disabled.</p>
          : offer.hostExpansion
            ? <p>This cluster has Passmower, so the chart defaults apply: OIDC login with each caller&apos;s own Kubernetes RBAC, Ingresses for MCP and the hosted dashboard, the scanner and crawlers.</p>
            : <p>This cluster has Passmower, so MCP uses OIDC login with each caller&apos;s own Kubernetes RBAC, plus the scanner and crawlers. Its admission does not expand the chart&apos;s short Ingress hosts (<code>mcp</code>, <code>dashboard</code>), so no Ingress or hosted dashboard is installed: the desktop reaches MCP by port-forward. Set real hostnames with the deployment guide to publish them.</p>}
        {!trust && offer.trustedCA !== "injected" && <p>{offer.trustedCA === "missing" ? "This cluster gives Pods no CA certificates, and Driftmower's images contain none." : "The desktop could not check whether this cluster gives Pods CA certificates; Driftmower's images contain none."} {anonymous ? "Anonymous MCP needs none, but other outbound HTTPS will fail until the cluster provides them." : "Without them MCP cannot fetch the OIDC signing keys and every login fails."} {CA_HELP}</p>}
        <p className="rounded border border-status-patch bg-status-patch-bg p-3 text-status-patch-label">{POLICY}</p>
        {needsStorage && <label className="block space-y-1">
          <span className="font-medium">Storage class</span>
          <span className="block text-muted-foreground">This cluster has no default StorageClass. The operator&apos;s scan cache and the registry scraper&apos;s catalog need a volume each; both are regenerable, so node-local storage is fine.</span>
          <select className="w-full rounded border bg-background px-2 py-1" value={storageClass} onChange={event => setStorageClass(event.target.value)}>
            <option value="">Choose a StorageClass…</option>
            {offer.storageClasses?.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded border px-3 py-2" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="rounded border bg-foreground px-3 py-2 text-background disabled:cursor-not-allowed disabled:opacity-40" disabled={!ready || (needsStorage && !storageClass)} title={!ready ? "trust-manager needs cert-manager" : needsStorage && !storageClass ? "Choose a StorageClass" : undefined} onClick={() => void install()}>Install</button>
        </div>
      </div>
    </dialog>}
  </div>
}
