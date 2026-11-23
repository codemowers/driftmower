"use client"
import Card from "@/app/components/layout/card"
import Page from "@/app/components/layout/page"

import Breadcrumbs from "@/app/components/breadcrumbs"
import PrefetchLink from "@/app/components/prefetch-link"
import PageLoading from "@/app/components/page-loading"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import RelatedResources, { resourceSummary } from "../../components/related-resources"

// A namespace's orphan bucket: resources no workload uses, generating owners
// whose root is gone, and Pods without an owner.
export default function OrphanBucket({ uid }: { uid: string }) {
  const data = useClusterState(s => s.data)
  const { linkTo } = useContextHref()
  if (!data) return <PageLoading loading="orphaned resources" />
  const bucket = data.workloads?.find(w => w.kind === "Namespace" && w.uid === uid)
  const owners = Object.entries(bucket?.orphaned ?? {}).sort(([a], [b]) => a.localeCompare(b))

  return (
    <>
      <Page>
        <Breadcrumbs items={[{ label: "Workloads", href: linkTo("/topmost-owners") }, ...(bucket ? [{ label: `Namespace ${bucket.namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(bucket.namespace)}`) }] : []), { label: "Orphaned resources" }]} />
        {!bucket ? (
          <p className="text-sm text-muted-foreground">Nothing is orphaned in this namespace now.</p>
        ) : (
          <>
            <header className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold">Orphaned resources</h1>
              <p className="font-mono text-sm text-muted-foreground">{bucket.namespace}</p>
              <p className="text-sm text-muted-foreground">Not used by any workload in the namespace. Orphaned does not mean safe to delete.</p>
            </header>

            <section className="flex flex-col gap-3 rounded-xl border border-gray-200 border-status-minor-bg bg-status-minor-bg/20 p-5">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Unused resources</h2>
              <RelatedResources deps={bucket} empty="None." />
            </section>

            {owners.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Owners without a workload</h2>
                <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
                  {owners.flatMap(([kind, byName]) => Object.entries(byName).sort(([a], [b]) => a.localeCompare(b)).map(([name, owner]) => (
                    <div key={`${kind}/${name}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 px-5 py-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{name}</div>
                        <div className="text-xs text-muted-foreground">
                          {kind}{owner.ownerReferenceOnly && " · known only from ownerReferences"}
                        </div>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {[owner.pods?.length ? `${owner.pods.length} Pod${owner.pods.length === 1 ? "" : "s"}` : "", resourceSummary(owner)].filter(Boolean).join(" · ") || "Nothing generated"}
                      </div>
                    </div>
                  )))}
                </div>
              </section>
            )}

            {(bucket.standalonePods ?? []).length > 0 && (
              <Card title="Pods without an owner" meta={bucket.standalonePods!.length}>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {bucket.standalonePods!.map(p => (
                    <PrefetchLink key={p.uid} href={linkTo(`/topmost-owners/${p.uid}`)} className="font-mono text-sm text-brand hover:underline">{p.name}</PrefetchLink>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </Page>
    </>
  )
}
