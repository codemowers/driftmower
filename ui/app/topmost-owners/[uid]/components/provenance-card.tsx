"use client"

import { useEffect, useState, type ReactNode } from "react"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import type { Subject } from "@/lib/features/users/types"
import { callTool, toolNames } from "@/browser/connection"
import { relativeTimeFromNow } from "@/lib/utils/format-time"
import SubjectLink from "@/app/users/components/subject-link"

type OwnerRecord = { createdBy?: Subject; createdAt?: string; updatedAt?: string; updatedBy?: string; provenance?: Record<string, string> }

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </>
  )
}

// Time ago, with the timestamp on hover.
function Ago({ at }: { at: string }) {
  return <time dateTime={at} title={new Date(at).toLocaleString()}>{relativeTimeFromNow(at)}</time>
}

// A custom-resource owner is not watched: its record is read as the caller
// when this page opens, where the server can impersonate.
function useOwnerRecord(root: ClusterResource) {
  const [record, setRecord] = useState<OwnerRecord>()
  useEffect(() => {
    if (!root.ownerReferenceOnly || !root.apiVersion) return
    let cancelled = false
    void toolNames().then(tools => tools.has("get_owner_record")
      ? callTool<OwnerRecord>("get_owner_record", { apiVersion: root.apiVersion, kind: root.kind, namespace: root.namespace, name: root.name, uid: root.uid })
      : undefined)
      .then(r => { if (!cancelled && r) setRecord(r) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [root.ownerReferenceOnly, root.apiVersion, root.kind, root.namespace, root.name, root.uid])
  return record
}

// Who and what created a top-level owner and when: the creator admission
// recorded, its age and latest write, and deploy markers the Helm and Argo CD
// cards do not already show.
export default function ProvenanceCard({ root }: { root: ClusterResource }) {
  const record = useOwnerRecord(root)
  const p = (root.ownerReferenceOnly ? record?.provenance : root.provenance) ?? {}
  const flux = p["helm.toolkit.fluxcd.io/name"]
  // A custom resource's own creator, once read; its child's creator is
  // usually the operator.
  const createdBy = root.ownerReferenceOnly ? record?.createdBy : root.createdBy
  const createdAt = root.ownerReferenceOnly ? record?.createdAt : root.createdAt
  const updatedAt = root.ownerReferenceOnly ? record?.updatedAt : root.updatedAt
  const updatedBy = root.ownerReferenceOnly ? record?.updatedBy : root.updatedBy
  const rows: ReactNode[] = []
  if (createdBy) rows.push(<Row key="created-by" label="Created by"><SubjectLink subject={createdBy} /></Row>)
  if (createdAt) rows.push(<Row key="age" label="Age"><Ago at={createdAt} /></Row>)
  if (updatedAt) rows.push(<Row key="updated" label="Updated"><Ago at={updatedAt} />{updatedBy && <span className="text-muted-foreground"> by <span className="font-mono">{updatedBy}</span></span>}</Row>)
  if (flux) rows.push(<Row key="flux" label="Flux HelmRelease"><span className="font-mono">{p["helm.toolkit.fluxcd.io/namespace"] ?? root.namespace}/{flux}</span></Row>)
  if (p["skaffold.dev/run-id"]) rows.push(<Row key="skaffold" label="Skaffold run"><span className="font-mono">{p["skaffold.dev/run-id"]}</span></Row>)
  if (!rows.length) return null

  return (
    <section className="rounded-xl border border-gray-200 bg-white px-6 py-5">
      <p className="-mx-6 mb-4 border-b border-gray-200 px-6 pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provenance</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2">{rows}</dl>
    </section>
  )
}
