"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useState } from "react"
import PageHeader from "../components/page-header"
import { FilterSearchInput } from "../components/filter-bar"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import PrefetchLink from "@/app/components/prefetch-link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { formatSignIn, type OIDCUser } from "@/lib/features/users/types"
import { useOIDCUsers } from "@/lib/features/users/groups"
import GroupChip from "@/app/groups/components/group-chip"

function matches(u: OIDCUser, query: string): boolean {
  return !query || [u.name, u.displayName ?? "", ...u.emails, ...u.groups].join(" ").toLowerCase().includes(query)
}

export default function UsersPage() {
  const { state, retry } = useOIDCUsers()
  const [query, setQuery] = useState("")
  const { linkTo } = useContextHref()


  const [showUngrouped, setShowUngrouped] = useState(false)
  const search = query.trim().toLowerCase()
  const matching = state.status === "ready" ? state.users.filter(u => matches(u, search)) : []
  // Users the OIDCUser gives no groups to hold no rights of their own.
  const ungrouped = matching.filter(u => u.groups.length === 0).length
  const users = showUngrouped ? matching : matching.filter(u => u.groups.length > 0)

  return (
    <>
      <Page>
        <PageHeader icon={ICONS.users} title="Users" subtitle="Passmower OIDC users; open one to see their effective Kubernetes rights" />

        {state.status === "loading" && <LoadingLine loading="users" />}
        {state.status === "error" && <LoadError message={`Failed to load users: ${state.message}`} onRetry={retry} />}

        <div className="flex items-center gap-4">
          <FilterSearchInput value={query} onChange={setQuery} placeholder="Search name, email, group or namespace..." />
          <label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
            <input type="checkbox" checked={showUngrouped} onChange={e => setShowUngrouped(e.target.checked)} />
            Show users without groups{!showUngrouped && ungrouped > 0 && ` (${ungrouped})`}
          </label>
        </div>

        {state.status === "ready" && (
          <section className="flex flex-col gap-3">
            {users.length === 0 ? (
              <p className="text-sm text-muted-foreground">{search ? "No users match that search." : "No OIDC users are visible to you."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">User</th>
                      <th className="py-2 pr-4 font-semibold">Groups</th>
                      <th className="py-2 pr-4 font-semibold">Passkeys</th>
                      <th className="py-2 font-semibold">Last sign-in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={`${u.namespace}/${u.name}`} className="border-t border-border align-top">
                        <td className="whitespace-nowrap py-2 pr-4">
                          <PrefetchLink href={linkTo(`/users/${encodeURIComponent(u.name)}`)} className="font-medium text-brand hover:underline">
                            {u.displayName || u.name}
                          </PrefetchLink>
                          <div className="text-xs text-muted-foreground">
                            {u.displayName && <>{u.name} · </>}{u.primaryEmail ?? u.emails[0] ?? ""}
                          </div>
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {u.groups.map(g => <GroupChip key={g} id={g} />)}
                          </div>
                        </td>
                        <td className="py-2 pr-4 tabular-nums">{u.passkeyCount}</td>
                        <td className="whitespace-nowrap py-2" title={u.lastSignIn ? new Date(u.lastSignIn).toLocaleString() : undefined}>
                          {formatSignIn(u.lastSignIn)}
                          {u.lastApplication && <div className="text-xs text-muted-foreground">{u.lastApplication}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </Page>
    </>
  )
}
