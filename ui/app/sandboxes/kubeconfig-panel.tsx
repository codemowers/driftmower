"use client"

import { useEffect, useState } from "react"
import { Check, Copy, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import CopyButton from "../components/copy-button"
import { cn } from "@/lib/utils/cn"
import { readApiError } from "@/lib/utils/read-api-error"
import { readContext } from "@/lib/features/sandboxes/kubeconfig"

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
  const [mergeCopied, setMergeCopied] = useState(false)

  useEffect(() => {
    if (cache.has(sandbox)) return

    let cancelled = false

    fetch(`/api/sandboxes/${encodeURIComponent(sandbox)}/kubeconfig`)
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          const message = await readApiError(res)
          if (!cancelled) setState({ status: "error", message })
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

  // Same merge recipe platform-manager hands out: write the sandbox config to a
  // scratch file, let `kubectl config view --raw` fold it into the existing
  // default config, then drop the scratch file and switch context.
  let mergeScript = ""
  let mergeContext = ""
  if (state.status === "ready") {
    const { context, clusterName } = readContext(state.yaml, sandbox)
    const kubeconfigPath = `$HOME/.kube/config-${clusterName}`
    mergeContext = context
    mergeScript = `kubectl krew install oidc-login
mkdir -p ~/.kube
touch ~/.kube/config
cat << EOF > ${kubeconfigPath}
${state.yaml.trimEnd()}
EOF
KUBECONFIG="$HOME/.kube/config:${kubeconfigPath}" kubectl config view --raw > $HOME/.kube/config.part
diff -u $HOME/.kube/config.part $HOME/.kube/config
mv $HOME/.kube/config.part $HOME/.kube/config
rm -fv ${kubeconfigPath}
kubectl config use-context ${context}`
  }

  function handleCopy() {
    if (state.status !== "ready") return
    navigator.clipboard.writeText(state.yaml)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleCopyMerge() {
    if (state.status !== "ready") return
    navigator.clipboard.writeText(mergeScript)
    setMergeCopied(true)
    setTimeout(() => setMergeCopied(false), 1500)
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
    // Side by side from lg up: the download flow and the paste-to-merge flow are
    // alternatives, so they read better as a choice than as a sequence. Below lg
    // they stack, since neither pre block survives a half-width phone column.
    <div className="grid gap-6 lg:grid-cols-2">
      <section
        className={cn(
          "flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5",
          // Nothing to sit beside while loading or failed: take the whole row.
          state.status !== "ready" && "lg:col-span-2",
        )}
      >
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
            <p className="text-xs text-muted-foreground">
              Scoped to this sandbox&rsquo;s namespace. Access is bound to the sandbox&rsquo;s owners, so
              this file works for each of them and for nobody else.
            </p>
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

      {state.status === "ready" && (
        <section className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Merge into ~/.kube/config
            </h2>
            <Button type="button" variant="outline" size="sm" onClick={handleCopyMerge}>
              {mergeCopied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {mergeCopied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Prefer no extra file to pass around? Paste this whole block into a shell. It merges the
            sandbox into your default kubeconfig and switches to the{" "}
            <code className="font-mono">{mergeContext}</code> context, leaving your other contexts
            untouched.
          </p>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-foreground">
            {mergeScript}
          </pre>
        </section>
      )}
    </div>
  )
}
