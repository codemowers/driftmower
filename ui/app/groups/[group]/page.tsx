"use client"

import { useParams } from "next/navigation"
import { ExternalLink } from "lucide-react"
import Breadcrumbs from "../../components/breadcrumbs"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import PrefetchLink from "@/app/components/prefetch-link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { groupsFromUsers, parseGroup, useOIDCUsers } from "@/lib/features/users/groups"
import { formatSignIn } from "@/lib/features/users/types"

export default function GroupDetailPage() {
  const params = useParams<{ group: string }>()
  const id = decodeURIComponent(params.group)
  const { state, retry } = useOIDCUsers()
  const { linkTo } = useContextHref()
  const info = parseGroup(id)
  const members = state.status === "ready" ? groupsFromUsers(state.users).find(g => g.id === id)?.members ?? [] : []

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <Breadcrumbs items={[{ label: "Groups", href: linkTo("/groups") }, { label: id }]} />
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{info.name}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{id}</span>{info.source && <> · from {info.source}</>}
          </p>
          {info.github && (
            <a href={info.github.url} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-sm text-brand hover:underline">
              GitHub team {info.github.org}/{info.github.team}<ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </header>

        {state.status === "loading" && <LoadingLine loading="members" />}
        {state.status === "error" && <LoadError message={`Failed to load members: ${state.message}`} onRetry={retry} />}

        {state.status === "ready" && (
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Members</h2>
              <span className="text-xs tabular-nums text-muted-foreground">{members.length}</span>
            </div>
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground">No OIDC user visible to you is a member of this group.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {members.map(m => (
                  <li key={`${m.namespace}/${m.name}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <div>
                      <PrefetchLink href={linkTo(`/users/${encodeURIComponent(m.name)}`)} className="font-medium text-brand hover:underline">{m.displayName || m.name}</PrefetchLink>
                      <span className="text-xs text-muted-foreground"> {m.displayName && <>{m.name} · </>}{m.primaryEmail ?? m.emails[0] ?? ""}</span>
                    </div>
                    <span className="text-xs text-muted-foreground" title={m.lastSignIn}>last sign-in {formatSignIn(m.lastSignIn).toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  )
}
