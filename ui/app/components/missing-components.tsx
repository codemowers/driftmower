"use client"

import { CopySnippet } from "@/app/components/copy-button"

// nodestatd publishes its chart, with the CRDs, DaemonSet and RBAC, to
// GitHub's container registry with every release.
const NODESTATD = "helm install nodestatd oci://ghcr.io/codemowers/charts/nodestatd --namespace kube-system"
const NODESTATD_K3S = `${NODESTATD} \\\n  --set containerd.socket=/run/k3s/containerd/containerd.sock`


// What the cluster lacks for drift and advisories, and how to install it.
export default function MissingComponents({ components }: { components: string[] }) {
  if (!components.includes("nodestatd")) return null
  return (
    <section className="flex flex-col gap-2 border-b border-status-patch bg-status-patch-bg/60 px-5 py-3 text-sm">
      <p className="text-status-patch-text">
        <span className="font-semibold">nodestatd is not installed.</span> It records the images each node holds as
        ContainerImage objects; without them the crawler has nothing to crawl, so version drift and security
        advisories and Trivy vulnerability scans are unavailable. Install it with Helm:
      </p>
      <CopySnippet text={NODESTATD} />
      <p className="text-xs text-status-patch-text">On k3s, point it at k3s&apos;s containerd socket:</p>
      <CopySnippet text={NODESTATD_K3S} />
      <p className="text-xs text-status-patch-text">Restart Driftmower MCP and the scanner after installation to discover the new APIs.</p>
    </section>
  )
}
