"use client"

import { useState } from "react"
import { ExternalLink } from "lucide-react"
import PageHeader from "../components/page-header"
import { FilterSearchInput } from "../components/filter-bar"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import PrefetchLink from "@/app/components/prefetch-link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { groupsFromUsers, useOIDCUsers } from "@/lib/features/users/groups"

export default function GroupsPage() {
  const { state, retry } = useOIDCUsers()
  const [query, setQuery] = useState("")
  const { linkTo } = useContextHref()

  const search = query.trim().toLowerCase()
  const groups = state.status === "ready"
    ? groupsFromUsers(state.users).filter(g => !search || [g.id, ...g.members.map(m => `${m.name} ${m.displayName ?? ""}`)].join(" ").toLowerCase().includes(search))
    : []

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Groups" subtitle="Passmower group memberships of OIDC users, as carried in their tokens" />

        {state.status === "loading" && <LoadingLine loading="groups" />}
        {state.status === "error" && <LoadError message={`Failed to load groups: ${state.message}`} onRetry={retry} />}

        {state.status === "ready" && (
          <>
            <div className="flex items-center gap-4">
              <FilterSearchInput value={query} onChange={setQuery} placeholder="Search group or member..." />
            </div>
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">{search ? "No groups match that search." : "No group memberships are visible to you."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">Group</th>
                      <th className="py-2 pr-4 font-semibold">Source</th>
                      <th className="py-2 pr-4 font-semibold">Members</th>
                      <th className="py-2 font-semibold">GitHub team</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map(g => (
                      <tr key={g.id} className="border-t border-border align-top">
                        <td className="py-2 pr-4">
                          <PrefetchLink href={linkTo(`/groups/${encodeURIComponent(g.id)}`)} className="font-medium text-brand hover:underline">{g.name}</PrefetchLink>
                          <div className="font-mono text-xs text-muted-foreground">{g.id}</div>
                        </td>
                        <td className="py-2 pr-4">{g.source || "—"}</td>
                        <td className="py-2 pr-4 tabular-nums" title={g.members.map(m => m.name).join(", ")}>{g.members.length}</td>
                        <td className="py-2">
                          {g.github ? (
                            <a href={g.github.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
                              {g.github.org}/{g.github.team}<ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
