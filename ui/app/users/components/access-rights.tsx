"use client"

import type { Grant, UserAccess } from "@/lib/features/users/types"

function verbs(vs: string[]): string {
  return vs.includes("*") ? "all verbs" : vs.join(", ")
}

function resourceLabel(g: Grant): string {
  const name = g.kind ?? (g.resource === "*" ? "all resources" : g.resource)
  const group = g.group === "*" ? "all API groups" : g.group || "core"
  return g.resource === "*" ? `${name} in ${group}` : `${name}${g.group ? ` (${g.group})` : ""}`
}

function GrantTable({ grants, showNamespaces }: { grants: Grant[]; showNamespaces: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-semibold">Kind</th>
            <th className="py-2 pr-4 font-semibold">Verbs</th>
            {showNamespaces && <th className="py-2 font-semibold">Namespaces</th>}
          </tr>
        </thead>
        <tbody>
          {grants.map(g => (
            <tr key={`${g.group}/${g.resource}/${(g.resourceNames ?? []).join(",")}/${(g.namespaces ?? []).join(",")}/${g.verbs.join(",")}`} className="border-t border-border align-top">
              <td className="py-2 pr-4">
                <div className="font-medium">{resourceLabel(g)}</div>
                {(g.clusterScoped || g.resourceNames?.length) && (
                  <div className="text-xs text-muted-foreground">
                    {g.clusterScoped && "cluster-scoped"}
                    {g.clusterScoped && g.resourceNames?.length ? " · " : ""}
                    {g.resourceNames?.length ? <>only <span className="font-mono">{g.resourceNames.join(", ")}</span></> : null}
                  </div>
                )}
              </td>
              <td className="py-2 pr-4">{verbs(g.verbs)}</td>
              {showNamespaces && (
                <td className="py-2">
                  <div className="flex flex-wrap gap-1">
                    {(g.namespaces ?? []).map(ns => (
                      <span key={ns} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{ns}</span>
                    ))}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// A user's effective rights: cluster-wide grants, then the extra rights per
// namespace, with incomplete evaluations and warnings.
export default function AccessRights({ access: a }: { access: UserAccess }) {
  return (
    <>
      {a.clusterAdmin ? (
        <p className="rounded-lg bg-status-major-bg px-4 py-3 text-sm text-status-major-text">
          Cluster administrator: every verb on every resource in every namespace.
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Everywhere</h2>
            <p className="text-sm text-muted-foreground">Rights in every namespace and on cluster-scoped resources.</p>
            {a.clusterWide.length ? <GrantTable grants={a.clusterWide} showNamespaces={false} /> : <p className="text-sm">None.</p>}
            {a.nonResourceURLs.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Non-resource URLs: {a.nonResourceURLs.map(n => `${n.urls.join(", ")} (${verbs(n.verbs)})`).join("; ")}
              </p>
            )}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Per namespace</h2>
            <p className="text-sm text-muted-foreground">
              Additional rights in specific namespaces. {a.examined.length} of {a.totalNamespaces} namespaces examined (those where the user may list Pods).
            </p>
            {a.namespaced.length ? <GrantTable grants={a.namespaced} showNamespaces /> : <p className="text-sm">None beyond the rights above.</p>}
          </section>
        </>
      )}

      {[...a.incomplete.map(n => `${n}: evaluation incomplete`), ...a.warnings].map(w => (
        <p key={w} className="text-sm text-muted-foreground">{w}</p>
      ))}
    </>
  )
}
