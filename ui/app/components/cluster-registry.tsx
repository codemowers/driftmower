"use client"

import { useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import { callTool, toolNames } from "@/browser/connection"

type Registry = { present: boolean; service?: string; host?: string }

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <span className="absolute right-3 top-2 z-10"><CopyButton value={text} /></span>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 pr-10 font-mono text-xs text-foreground">{text}</pre>
    </div>
  )
}

// The cluster-wide Zot registry, when the platform runs one: where to make
// an API key, how to log in with it, and the skaffold.env lines that push
// there. A sandbox's own registry comes with its credentials already
// provisioned, on the Container registry page.
export default function ClusterRegistry() {
  const [registry, setRegistry] = useState<Registry | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (!(await toolNames()).has("get_cluster_registry")) return
        const r = await callTool<Registry>("get_cluster_registry")
        if (!cancelled) setRegistry(r)
      } catch { /* Nothing to show. */ }
    })()
    return () => { cancelled = true }
  }, [])
  if (!registry?.present) return null

  const host = registry.host
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cluster registry</h2>
      <p className="text-sm text-muted-foreground">
        This cluster runs a shared Zot registry at <code className="font-mono text-xs">{registry.service}</code>
        {host ? <>, published as <code className="font-mono text-xs">{host}</code></> : ", without a public address"}.
      </p>
      {host && (
        <>
          <p className="text-sm">
            Sign in to the{" "}
            <a href={`https://${host}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text underline">
              Zot web UI<ExternalLink className="size-3" />
            </a>{" "}
            and create an API key under your user menu, then log in with your Zot username and that key as the password:
          </p>
          <Snippet text={`docker login ${host} -u <username>`} />
          <p className="text-sm">In <code className="font-mono text-xs">skaffold.env</code>, push images under your user:</p>
          <Snippet text={`SKAFFOLD_DEFAULT_REPO=${host}/<username>`} />
        </>
      )}
    </section>
  )
}
