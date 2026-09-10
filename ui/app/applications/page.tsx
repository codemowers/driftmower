"use client"

import { useState } from "react"
import PageHeader from "../components/page-header"
import { FilterSearchInput } from "../components/filter-bar"
import { Switch } from "@/components/ui/switch"
import ApplicationTile from "./components/application-tile"
import { scopedHosts, useApplications } from "@/lib/features/applications/use-applications"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { resolveManagerLink } from "@/lib/features/applications/manager-link"
import type { ApplicationEntry } from "@/lib/features/applications/types"

function matches(entry: ApplicationEntry, query: string): boolean {
  if (!query) return true
  return [entry.name, entry.url, entry.namespace ?? "", entry.managerUID ?? "", entry.argoApp?.name ?? "", ...entry.groups]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

export default function ApplicationsPage() {
  const { launcher, inventory } = useApplications()
  const releaseScores = useClusterState(s => s.data?.rotenness.releaseScores)
  const { namespaces } = useSandboxScope()
  const [query, setQuery] = useState("")
  const [showAll, setShowAll] = useState(false)

  const search = query.trim().toLowerCase()

  const available = launcher.status === "ready" ? launcher.entries.filter(e => matches(e, search)) : []

  const others =
    inventory.status === "ready"
      ? scopedHosts(inventory.entries, namespaces).filter(e => matches(e, search))
      : []

  const hasInventory = inventory.status === "ready" && inventory.entries.length > 0

  function renderTiles(entries: ApplicationEntry[]) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map(entry => (
          <ApplicationTile key={entry.key} entry={entry} manager={resolveManagerLink(entry, releaseScores)} />
        ))}
      </div>
    )
  }

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="Applications"
          subtitle="Applications you can reach, and the other hosts in your namespaces"
        />

        {launcher.status === "loading" && (
          <p className="text-sm text-muted-foreground">Loading applications…</p>
        )}

        {launcher.status === "stale-session" && (
          <p className="text-sm text-muted-foreground">
            Your session is missing the applications scope. Log out and back in to refresh it.
          </p>
        )}

        {launcher.status === "scope-not-configured" && (
          <p className="text-sm text-muted-foreground">
            This deployment does not request the applications scope. Add it to OIDC_SCOPE and redeploy.
          </p>
        )}

        {launcher.status === "error" && (
          <p className="text-sm text-status-major">
            Failed to load applications: {launcher.message}
          </p>
        )}

        {launcher.status === "ready" && (
          <>
            <div className="flex items-center gap-4">
              <FilterSearchInput
                value={query}
                onChange={setQuery}
                placeholder="Search applications, hosts, namespaces..."
              />
              {hasInventory && (
                <label className="flex shrink-0 cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground">
                  Show all hosts
                  <Switch checked={showAll} onCheckedChange={setShowAll} />
                </label>
              )}
            </div>

            <section className="flex flex-col gap-3">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Available to you
                </h2>
                <span className="text-xs tabular-nums text-muted-foreground">{available.length}</span>
              </div>
              {available.length > 0 ? (
                renderTiles(available)
              ) : (
                <p className="text-sm text-muted-foreground">
                  {search ? "No applications match that search." : "passmower has no applications registered for you."}
                </p>
              )}
            </section>

            {inventory.status === "error" && (
              <p className="text-sm text-muted-foreground">Could not list cluster hosts.</p>
            )}

            {inventory.status === "ready" && inventory.tenancy === "unreachable" && (
              <p className="text-sm text-muted-foreground">
                platform-manager is not answering, so this list may be missing hosts.
              </p>
            )}

            {inventory.status === "ready" && inventory.tenancy === "unauthenticated" && (
              <p className="text-sm text-muted-foreground">
                Your session expired. Log out and back in to load the rest of the hosts.
              </p>
            )}

            {showAll && (
              <section className="flex flex-col gap-3">
                <div className="flex items-baseline gap-2.5">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {namespaces ? "Other hosts in your namespaces" : "Other hosts discovered"}
                  </h2>
                  <span className="text-xs tabular-nums text-muted-foreground">{others.length}</span>
                </div>
                {others.length > 0 ? (
                  renderTiles(others)
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {search ? "No hosts match that search." : "No other hosts in this scope."}
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
