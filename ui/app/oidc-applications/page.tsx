"use client"

import { useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import PageHeader from "../components/page-header"
import ClusterScopeBanner from "../components/cluster-scope-banner"

type OidcApp = {
  name: string
  url: string
  groups: string[]
  displayOrder: number
  // Markdown pre-rendered to sanitized HTML by passmower.
  description: string | null
  metadata: unknown
}

type FetchState =
  | { status: "loading" }
  | { status: "stale-session" }
  | { status: "error"; message: string }
  | { status: "ready"; apps: OidcApp[] }

function AppCard({ app }: { app: OidcApp }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <a
        href={app.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1.5 font-heading text-base font-semibold text-foreground hover:underline"
      >
        {app.name}
        <ExternalLink className="size-3.5 text-muted-foreground" />
      </a>
      <p className="break-all text-xs text-muted-foreground">{app.url}</p>
      {app.description && (
        <div
          className="prose prose-sm text-sm text-muted-foreground [&_a]:underline"
          dangerouslySetInnerHTML={{ __html: app.description }}
        />
      )}
      {app.groups.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {app.groups.map(group => (
            <span
              key={group}
              className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
            >
              {group}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function OidcApplicationsPage() {
  const [state, setState] = useState<FetchState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false

    fetch("/api/oidc-applications")
      .then(async res => {
        if (cancelled) return
        if (res.status === 403) {
          setState({ status: "stale-session" })
          return
        }
        if (!res.ok) {
          setState({ status: "error", message: `Request failed with status ${res.status}` })
          return
        }
        const body: { apps: OidcApp[] } = await res.json()
        if (!cancelled) setState({ status: "ready", apps: body.apps })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="OIDC Applications"
          subtitle="Applications available to you"
        />
        <ClusterScopeBanner />

        {state.status === "loading" && (
          <p className="text-sm text-muted-foreground">Loading applications…</p>
        )}

        {state.status === "stale-session" && (
          <p className="text-sm text-muted-foreground">
            Your session is missing the applications scope — log out and back in to refresh it.
          </p>
        )}

        {state.status === "error" && (
          <p className="text-sm text-status-major">
            Failed to load applications: {state.message}
          </p>
        )}

        {state.status === "ready" && (
          state.apps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No applications available.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {state.apps.map(app => (
                <AppCard key={`${app.name}-${app.url}`} app={app} />
              ))}
            </div>
          )
        )}
      </main>
    </div>
  )
}
