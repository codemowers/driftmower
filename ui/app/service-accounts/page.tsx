"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useState } from "react"
import PageHeader from "@/app/components/page-header"
import { FilterSearchInput } from "@/app/components/filter-bar"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import PrefetchLink from "@/app/components/prefetch-link"
import SubjectLink from "@/app/users/components/subject-link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import type { ServiceAccount } from "@/lib/features/users/types"
import { useServiceAccounts } from "@/lib/features/users/groups"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"

function saMatches(sa: ServiceAccount, query: string): boolean {
  return !query || [sa.namespace, sa.name, sa.createdBy?.username ?? ""].join(" ").toLowerCase().includes(query)
}

// Every ServiceAccount; open one to see its effective rights.
export default function ServiceAccountsPage() {
  const [query, setQuery] = useState("")
  const search = query.trim().toLowerCase()
  const { state, retry } = useServiceAccounts()
  const { linkTo } = useContextHref()
  const [showDefault, setShowDefault] = useState(false)
  const matching = state.status === "ready" ? state.serviceAccounts.filter(sa => saMatches(sa, search)) : []
  // Every namespace has a default ServiceAccount; it matters only once bound.
  const plainDefault = (sa: ServiceAccount) => sa.name === "default" && !sa.bound
  const hidden = showDefault ? 0 : matching.filter(plainDefault).length
  const accounts = showDefault ? matching : matching.filter(sa => !plainDefault(sa))
  return (
    <>
      <Page>
    <PageHeader icon={ICONS.serviceAccounts} title="Service accounts" subtitle="Kubernetes ServiceAccounts; open one to see its effective Kubernetes rights" />
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="w-80"><FilterSearchInput value={query} onChange={setQuery} placeholder="Search name, namespace or creator..." /></div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showDefault} onChange={e => setShowDefault(e.target.checked)} />
          Show default service accounts without bindings{hidden > 0 && ` (${hidden})`}
        </label>
      </div>
      {state.status === "loading" && <LoadingLine loading="service accounts" />}
      {state.status === "error" && <LoadError message={`Failed to load service accounts: ${state.message}`} onRetry={retry} />}
      {state.status === "ready" && (accounts.length === 0
        ? <p className="text-sm text-muted-foreground">{search ? "No service accounts match that search." : "No service accounts are visible to you."}</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-semibold">Service account</th>
                  <th className="py-2 pr-4 font-semibold">Namespace</th>
                  <th className="py-2 pr-4 font-semibold">Created by</th>
                  <th className="py-2 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(sa => (
                  <tr key={`${sa.namespace}/${sa.name}`} className="border-t border-border align-top">
                    <td className="py-2 pr-4">
                      <PrefetchLink href={linkTo(`/service-accounts/${encodeURIComponent(sa.namespace)}/${encodeURIComponent(sa.name)}`)} className="font-medium text-brand hover:underline">
                        {sa.name}
                      </PrefetchLink>
                    </td>
                    <td className="py-2 pr-4">
                      <PrefetchLink href={linkTo(`/namespaces/${encodeURIComponent(sa.namespace)}`)} className="hover:text-brand-text hover:underline">{sa.namespace}</PrefetchLink>
                    </td>
                    <td className="py-2 pr-4 text-xs">{sa.createdBy ? <SubjectLink subject={sa.createdBy} /> : <span className="text-muted-foreground">unknown</span>}</td>
                    <td className="whitespace-nowrap py-2 text-muted-foreground" title={new Date(sa.createdAt).toLocaleString()}>{compactRelativeTimeFromNow(sa.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
      </Page>
    </>
  )
}
