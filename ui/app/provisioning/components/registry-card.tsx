"use client"

import { Package } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import { sandboxRegistryHost } from "@/lib/features/provisioning/registry-facts"
import type { IngressFact, NamespaceFact } from "@/lib/features/provisioning/types"

const ROBOT_SECRET = "registry-robot"
const PULL_SECRET = "registry-pull"

function loginCommand(namespace: string, host: string): string {
  return `kubectl -n ${namespace} get secret ${ROBOT_SECRET} -o jsonpath='{.data.password}' | base64 -d | \\
  docker login ${host} \\
    --username "$(kubectl -n ${namespace} get secret ${ROBOT_SECRET} -o jsonpath='{.data.username}' | base64 -d)" \\
    --password-stdin`
}

function pushCommands(host: string): string {
  return `docker tag myapp:v1 ${host}/myapp:v1
docker push ${host}/myapp:v1`
}

// skaffold keys its global config by kube-context, so the registry follows the
// sandbox context instead of being pinned in a shared skaffold.yaml.
function skaffoldCommands(host: string): string {
  return `skaffold config set --kube-context "$(kubectl config current-context)" default-repo ${host}
skaffold dev`
}

function podSnippet(namespace: string, host: string): string {
  return `apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: ${namespace}
spec:
  imagePullSecrets:
    - name: ${PULL_SECRET}
  containers:
    - name: myapp
      image: ${host}/myapp:v1`
}

export default function RegistryCard({
  namespaces,
  ingress,
}: {
  namespaces: NamespaceFact[]
  ingress: IngressFact
}) {
  const enabled = namespaces.filter(entry => entry.registryEnabled && entry.sandbox)

  if (enabled.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        None of the selected sandboxes has its container registry enabled. Enable the container registry in
        the sandbox&rsquo;s Features &amp; policies settings first.
      </p>
    )
  }

  if (!ingress.domainSuffix) {
    return (
      <p className="text-sm text-muted-foreground">
        The registry is enabled, but this cluster publishes no ingress domain, so its public Zot address
        cannot be derived here.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {enabled.map(entry => {
        const host = sandboxRegistryHost(entry.sandbox!, ingress.domainSuffix!)
        const login = loginCommand(entry.namespace, host)
        const push = pushCommands(host)
        const skaffold = skaffoldCommands(host)
        const pod = podSnippet(entry.namespace, host)

        return (
          <div key={entry.namespace} className="rounded-lg border border-border bg-card px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Package className="size-4 shrink-0 text-brand-icon" aria-hidden />
              <a
                href={`https://${host}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-foreground hover:underline"
              >
                {host}
              </a>
              <CopyButton value={host} />
              <span className="font-mono text-xs text-muted-foreground">{entry.namespace}</span>
            </div>

            <p className="mt-3 text-sm text-muted-foreground">
              Sign in to the Zot web UI with your platform account. For Docker or CI, use the robot
              credential already stored in <code className="font-mono text-xs text-brand-label">{ROBOT_SECRET}</code>.
            </p>

            <CommandBlock label="Log in from a shell" value={login} />
            <CommandBlock label="Tag and push an image" value={push} />
            <CommandBlock label="Or point skaffold at it for this context" value={skaffold} />
            <p className="mt-2 text-sm text-muted-foreground">
              Run it with the sandbox&rsquo;s kube-context selected. skaffold then prefixes every image in
              <code className="mx-1 font-mono text-xs text-brand-label">skaffold.yaml</code>
              with this registry, so keep image names bare (<code className="font-mono text-xs text-brand-label">myapp</code>)
              and the same config deploys to other contexts with their own registries.
            </p>
            <CommandBlock label={`Pull it in ${entry.namespace}`} value={pod} />

            <p className="mt-3 text-sm text-muted-foreground">
              Repository names start directly after the host; do not repeat the sandbox id. The pre-created
              <code className="mx-1 font-mono text-xs text-brand-label">{PULL_SECRET}</code>
              secret lets pods authenticate when pulling.
            </p>
          </div>
        )
      })}
    </div>
  )
}

function CommandBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{label}:</span>
        <CopyButton value={value} />
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
        {value}
      </pre>
    </div>
  )
}
