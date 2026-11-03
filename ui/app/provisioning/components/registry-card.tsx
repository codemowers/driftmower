"use client"

import { Package } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import type { NamespaceFact, RegistryFact } from "@/lib/features/provisioning/types"
import type { SandboxInfo } from "@/lib/tenancy/sandbox-context"

const ROBOT_SECRET = "registry-robot"
const PULL_SECRET = "registry-pull"
const SKAFFOLD_DOCS_URL = "https://skaffold.dev/docs/"

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

// Same paste-and-run shape as the kubeconfig merge recipe: the env file's
// contents come from driftmower-mcp, the heredoc just writes them in place.
function skaffoldEnvCommand(skaffoldEnv: string): string {
  return `cat << EOF > skaffold.env
${skaffoldEnv.trimEnd()}
EOF`
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

// Whether a sandbox has its registry is platform-manager's setting, so it comes
// from the sandbox list (/api/sandboxes). Where the registry answers, and the
// skaffold.env to build against it, are discovered by driftmower-mcp from the
// namespace's own Deployment, Service and Ingress, so a host naming convention
// is never guessed here.
export default function RegistryCard({
  sandboxes,
  namespaces,
}: {
  sandboxes: SandboxInfo[]
  namespaces: NamespaceFact[]
}) {
  const enabled = sandboxes.filter(entry => entry.registryEnabled)

  if (enabled.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        None of the selected sandboxes has its container registry enabled. Enable the container registry in
        the sandbox&rsquo;s Features &amp; policies settings first.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {enabled.map(entry => {
        const registry = namespaces.find(fact => fact.namespace === entry.namespace)?.registries?.[0]

        return registry ? (
          <RegistryDetails key={entry.namespace} namespace={entry.namespace} registry={registry} />
        ) : (
          <div key={entry.namespace} className="rounded-lg border border-border bg-card px-5 py-4">
            <span className="font-mono text-xs text-muted-foreground">{entry.namespace}</span>
            <p className="mt-2 text-sm text-muted-foreground">
              The registry is enabled, but no Zot published from this namespace was found yet. It may still be
              starting; if it stays missing, check &ldquo;Not checked&rdquo; above for a read the capability layer
              was refused.
            </p>
          </div>
        )
      })}
    </div>
  )
}

function RegistryDetails({ namespace, registry }: { namespace: string; registry: RegistryFact }) {
  const { host } = registry

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Package className="size-4 shrink-0 text-brand-icon" aria-hidden />
        <a
          href={`${registry.tls ? "https" : "http"}://${host}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-sm text-foreground hover:underline"
        >
          {host}
        </a>
        <CopyButton value={host} />
        <span className="font-mono text-xs text-muted-foreground">{namespace}</span>
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        Sign in to the Zot web UI with your platform account. For Docker or CI, use the robot
        credential already stored in <code className="font-mono text-xs text-brand-label">{ROBOT_SECRET}</code>.
      </p>

      <CommandBlock label="Log in from a shell" value={loginCommand(namespace, host)} />
      <CommandBlock label="Tag and push an image" value={pushCommands(host)} />
      <CommandBlock
        label="Or build with skaffold: run next to skaffold.yaml to write skaffold.env"
        value={skaffoldEnvCommand(registry.skaffoldEnv)}
      />
      <p className="mt-2 text-sm text-muted-foreground">
        <a
          href={SKAFFOLD_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-label underline underline-offset-2"
        >
          skaffold
        </a>{" "}
        reads this file on every run, so builds are pushed to this registry and deployed to {namespace}
        {" "}through its own kube-context, whichever context is current. Keep image names in
        <code className="mx-1 font-mono text-xs text-brand-label">skaffold.yaml</code>
        bare (<code className="font-mono text-xs text-brand-label">myapp</code>): skaffold prefixes them with
        this registry. The file is specific to this sandbox, so keep it out of version control. The context it
        names must exist in your kubeconfig.
      </p>
      <CommandBlock label={`Pull it in ${namespace}`} value={podSnippet(namespace, host)} />

      <p className="mt-3 text-sm text-muted-foreground">
        Repository names start directly after the host; do not repeat the sandbox id. The pre-created
        <code className="mx-1 font-mono text-xs text-brand-label">{PULL_SECRET}</code>
        secret lets pods authenticate when pulling.
      </p>
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
