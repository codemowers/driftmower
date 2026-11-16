"use client"

import CopyButton from "@/app/components/copy-button"

// nodestatd publishes its chart, with the CRDs, DaemonSet and RBAC, to
// GitHub's container registry with every release.
const NODESTATD = "helm install nodestatd oci://ghcr.io/codemowers/charts/nodestatd --namespace kube-system"
const NODESTATD_K3S = `${NODESTATD} \\\n  --set containerd.socket=/run/k3s/containerd/containerd.sock`

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <span className="absolute right-3 top-2 z-10"><CopyButton value={text} /></span>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 pr-10 font-mono text-xs text-foreground">{text}</pre>
    </div>
  )
}

// What the cluster lacks for drift and advisories, and how to install it.
export default function MissingComponents({ components }: { components: string[] }) {
  if (!components.includes("nodestatd")) return null
  return (
    <section className="flex flex-col gap-2 border-b border-status-patch bg-status-patch-bg/60 px-5 py-3 text-sm">
      <p className="text-status-patch-text">
        <span className="font-semibold">nodestatd is not installed.</span> It records the images each node holds as
        ContainerImage objects; without them the crawler has nothing to crawl, so version drift and security
        advisories are missing. Install it with Helm:
      </p>
      <Snippet text={NODESTATD} />
      <p className="text-xs text-status-patch-text">On k3s, point it at k3s&apos;s containerd socket:</p>
      <Snippet text={NODESTATD_K3S} />
    </section>
  )
}
