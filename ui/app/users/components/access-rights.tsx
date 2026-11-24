"use client"

import { useState } from "react"
import Card from "@/app/components/layout/card"
import { SEVERITY_STYLE } from "@/lib/cluster/styles/status-style"
import {accessWarningReasons} from "@/lib/features/users/access-warnings"
import type { Grant, UserAccess } from "@/lib/features/users/types"

function VerbLabels({ verbs }: { verbs: string[] }) {
  return <div className="flex flex-wrap gap-1">{verbs.map(verb => {
    const style = verb === "create" ? SEVERITY_STYLE.patch_behind
      : ["get", "list", "watch"].includes(verb) ? SEVERITY_STYLE.no_data : SEVERITY_STYLE.major_behind
    return <span key={verb} className={`rounded px-1.5 py-0.5 font-mono text-xs ${style.bg} ${style.text}`}>{verb === "*" ? "all verbs" : verb}</span>
  })}</div>
}

function resourceLabel(g: Grant): string {
  const name = g.kind ?? (g.resource === "*" ? "all resources" : g.resource)
  return g.group ? `${g.group}/${name}` : name
}

function namespaceKey(g: Grant): string {
  return JSON.stringify([...new Set(g.namespaces ?? [])].sort())
}

function GrantTable({ grants, showNamespaces }: { grants: Grant[]; showNamespaces: boolean }) {
  const sorted = [...grants].sort((a, b) => resourceLabel(a).localeCompare(resourceLabel(b)))
  return (
    <div className={showNamespaces ? "overflow-x-clip" : "overflow-x-auto"}>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-semibold">Kind</th>
            <th className="py-2 pr-4 font-semibold">Verbs</th>
            {showNamespaces && <th className="py-2 font-semibold">Namespaces</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((g, index) => {
            const key = namespaceKey(g)
            const firstNamespaceRow = index === 0 || namespaceKey(sorted[index - 1]) !== key
            let namespaceRows = 1
            if (showNamespaces && firstNamespaceRow) {
              while (index + namespaceRows < sorted.length && namespaceKey(sorted[index + namespaceRows]) === key) namespaceRows++
            }
            return (
            <tr key={`${g.group}/${g.resource}/${(g.resourceNames ?? []).join(",")}/${(g.namespaces ?? []).join(",")}/${g.verbs.join(",")}`} className="border-t border-border align-top">
              <td className="py-2 pr-4">
                <div className="font-mono text-xs font-medium">{resourceLabel(g)}</div>
                {(g.clusterScoped || g.resourceNames?.length) && (
                  <div className="text-xs text-muted-foreground">
                    {g.clusterScoped && "cluster-scoped"}
                    {g.clusterScoped && g.resourceNames?.length ? " · " : ""}
                    {g.resourceNames?.length ? <>only <span className="font-mono">{g.resourceNames.join(", ")}</span></> : null}
                  </div>
                )}
              </td>
              <td className="py-2 pr-4"><VerbLabels verbs={g.verbs} /></td>
              {showNamespaces && firstNamespaceRow && (
                <td className="py-2" rowSpan={namespaceRows}>
                  <div className="sticky top-4 flex flex-col items-start gap-1">
                    {[...new Set(g.namespaces ?? [])].sort().map(ns => (
                      <span key={ns} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{ns}</span>
                    ))}
                  </div>
                </td>
              )}
            </tr>
          )})}
        </tbody>
      </table>
    </div>
  )
}

// A user's effective rights: cluster-wide grants, then the extra rights per
// namespace, with incomplete evaluations and warnings.
export default function AccessRights({ access: a }: { access: UserAccess }) {
  const [verb, setVerb] = useState("")
  const allGrants = [...a.clusterWide, ...a.namespaced, ...a.nonResourceURLs]
  const availableVerbs = [...new Set([...allGrants.flatMap(g => g.verbs).filter(v => v !== "*"), ...(allGrants.some(g => g.verbs.includes("*")) ? ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"] : [])])].sort()
  const matchesVerb = (g: { verbs: string[] }) => !verb || g.verbs.includes(verb) || g.verbs.includes("*")
  const clusterWide = a.clusterWide.filter(matchesVerb)
  const namespaced = a.namespaced.filter(matchesVerb)
  const nonResourceURLs = a.nonResourceURLs.filter(matchesVerb)
  const incompleteNamespaces=a.incomplete.filter(Boolean)
  const incompleteScopes=[a.incomplete.includes("")?"cluster-wide":undefined,incompleteNamespaces.length?`${incompleteNamespaces.length} namespaces`:undefined].filter(Boolean).join(" and ")
  return (
    <>
      {a.clusterAdmin ? (
        <Card title="Everywhere"><p className="text-sm text-status-major-text">
          Cluster administrator: every verb on every resource in every namespace.
        </p></Card>
      ) : (
        <>
          <label className="flex items-center gap-3 text-sm">
            Filter by verb
            <select value={verb} onChange={event => setVerb(event.target.value)} className="rounded border px-3 py-2 font-mono">
              <option value="">All verbs</option>
              {availableVerbs.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <Card title="Everywhere">
            <p className="text-sm text-muted-foreground">Rights in every namespace and on cluster-scoped resources.</p>
            {clusterWide.length ? <GrantTable grants={clusterWide} showNamespaces={false} /> : <p className="text-sm">{verb ? "No cluster-wide grants match this verb." : a.incomplete.includes("")?"No cluster-wide grants were resolved; other permissions are unknown.":"None."}</p>}
            {nonResourceURLs.length > 0 && (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Non-resource URLs</p>
                {nonResourceURLs.map(n => <div key={JSON.stringify(n)} className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{n.urls.join(", ")}</span><VerbLabels verbs={n.verbs} /></div>)}
              </div>
            )}
          </Card>
          <Card title="Per namespace">
            <p className="text-sm text-muted-foreground">
              Additional rights in specific namespaces. {a.examined.length} of {a.totalNamespaces} namespaces examined (those where the user may list Pods).
            </p>
            {namespaced.length ? <GrantTable grants={namespaced} showNamespaces /> : <p className="text-sm">{verb ? "No additional grants match this verb." : a.incomplete.some(Boolean)?"No additional grants were resolved; other permissions are unknown.":"None beyond the rights above."}</p>}
          </Card>
        </>
      )}

      {a.incomplete.length>0&&<div className="space-y-2 text-sm text-muted-foreground">
        <p>Only the permissions the API server could enumerate are shown; additional permissions remain unknown, not denied.</p>
        <details><summary className="cursor-pointer">Incomplete reviews: {incompleteScopes}</summary><p className="mt-1">{a.incomplete.map(scope=>scope||"Cluster-wide").join(", ")}</p></details>
      </div>}
      {accessWarningReasons(a).map(w=><p key={w} className="text-sm text-muted-foreground">{w}</p>)}
    </>
  )
}
