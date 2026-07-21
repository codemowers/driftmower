"use client"

import { useState, useEffect } from "react"
import { Check, FileTerminal, Layers } from "lucide-react"
import { Button } from "@/components/ui/button"
import PageHeader from "../components/page-header"
import KubeconfigPanel from "./kubeconfig-panel"
import { selectTenant, useTenantContext } from "@/lib/tenancy/tenant-context"

type Tenant = {
  tenant: string
  tenantNamespace: string
  appNamespaces: string[]
  owners: string[]
  creator?: string
  stackChannel: string
}

type FetchState =
  | { status: "loading" }
  | { status: "stale-session" }
  | { status: "not-configured" }
  | { status: "error"; message: string }
  | { status: "ready"; admin: boolean; tenants: Tenant[] }

function TenantCard({ tenant }: { tenant: Tenant }) {
  const [showKubeconfig, setShowKubeconfig] = useState(false)
  const isContext = useTenantContext(s => s.selectedTenant) === tenant.tenant

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-heading text-base font-semibold text-foreground">
          {tenant.tenant}
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
          {tenant.stackChannel}
        </span>
      </div>

      <p className="font-mono text-xs text-muted-foreground">
        Namespace: {tenant.tenantNamespace}
      </p>

      {tenant.appNamespaces.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">App namespaces</p>
          <div className="flex flex-wrap gap-1.5">
            {tenant.appNamespaces.map(ns => (
              <span
                key={ns}
                className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {ns}
              </span>
            ))}
          </div>
        </div>
      )}

      {tenant.owners.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">Owners</p>
          <div className="flex flex-wrap gap-1.5">
            {tenant.owners.map(owner => (
              <span
                key={owner}
                className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {owner}
              </span>
            ))}
          </div>
        </div>
      )}

      {tenant.creator && (
        <p className="text-xs text-muted-foreground">Created by {tenant.creator}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={showKubeconfig}
          onClick={() => setShowKubeconfig(v => !v)}
        >
          <FileTerminal aria-hidden />
          Kubeconfig
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isContext}
          onClick={() => selectTenant(tenant.tenant)}
        >
          {isContext ? <Check aria-hidden /> : <Layers aria-hidden />}
          {isContext ? "Current context" : "Set as context"}
        </Button>
      </div>

      {showKubeconfig && <KubeconfigPanel tenant={tenant.tenant} />}
    </div>
  )
}

export default function TenantsPage() {
  const [state, setState] = useState<FetchState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false

    fetch("/api/tenants")
      .then(async res => {
        if (cancelled) return
        if (res.status === 401) {
          setState({ status: "stale-session" })
          return
        }
        if (res.status === 404) {
          setState({ status: "not-configured" })
          return
        }
        if (!res.ok) {
          setState({ status: "error", message: `Request failed with status ${res.status}` })
          return
        }
        const body: { admin: boolean; tenants: Tenant[] } = await res.json()
        if (!cancelled) setState({ status: "ready", admin: body.admin, tenants: body.tenants })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="Tenants"
          subtitle="Your tenants and their kubeconfig snippets"
        />

        {state.status === "loading" && (
          <p className="text-sm text-muted-foreground">Loading tenants…</p>
        )}

        {state.status === "stale-session" && (
          <p className="text-sm text-muted-foreground">
            Your session can&apos;t obtain a platform-manager token — log out and back in to refresh it.
          </p>
        )}

        {state.status === "not-configured" && (
          <p className="text-sm text-muted-foreground">
            Tenant management is not configured for this cluster (platform-manager is not deployed).
          </p>
        )}

        {state.status === "error" && (
          <p className="text-sm text-status-major">
            Failed to load tenants: {state.message}
          </p>
        )}

        {state.status === "ready" && (
          state.tenants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tenants available.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {state.admin && (
                <p className="text-sm text-muted-foreground">
                  You are a platform admin — all managed tenants are listed.
                </p>
              )}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {state.tenants.map(tenant => (
                  <TenantCard key={tenant.tenant} tenant={tenant} />
                ))}
              </div>
            </div>
          )
        )}
      </main>
    </div>
  )
}
