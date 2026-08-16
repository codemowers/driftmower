"use client"

import PageHeader from "../components/page-header"
import ClusterScopePill from "../components/cluster-scope-pill"
import OidcApplicationTile from "./components/oidc-application-tile"
import { useOidcApplications } from "./hooks/use-oidc-applications"

export default function OidcApplicationsPage() {
  const state = useOidcApplications()

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="OIDC Applications"
          subtitle="Applications available to you"
          accessory={<ClusterScopePill />}
        />

        {state.status === "loading" && (
          <p className="text-sm text-muted-foreground">Loading applications…</p>
        )}

        {state.status === "stale-session" && (
          <p className="text-sm text-muted-foreground">
            Your session is missing the applications scope. Log out and back in to refresh it.
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
                <OidcApplicationTile key={`${app.name}-${app.url}`} app={app} />
              ))}
            </div>
          )
        )}
      </main>
    </div>
  )
}
