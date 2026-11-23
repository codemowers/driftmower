"use client"
import type { LucideIcon } from "lucide-react"
import Page from "@/app/components/layout/page"

import type { ReactNode } from "react"
import PageHeader from "@/app/components/page-header"
import LoadingLine from "@/app/components/loading-line"
import ProvisioningScopePill from "./scope-pill"
import { useCapabilities } from "@/lib/features/provisioning/use-capabilities"
import { useSandboxContext, useSandboxScope, type SandboxInfo } from "@/lib/tenancy/sandbox-context"
import type { CapabilityResponse } from "@/lib/features/provisioning/types"

const NOT_IN_CLUSTER =
  "This page reads what the cluster supports through driftmower-mcp, which reported that it is not running in a cluster."

export type CapabilityView = { capabilities: CapabilityResponse; scoped: boolean; sandboxes: SandboxInfo[] }

// A page built from what the cluster supports: namespace-scoped facts are
// read for the selected sandbox's namespaces, cluster-wide ones always.
export default function CapabilitiesPage({ icon, title, subtitle, children }: { icon: LucideIcon; title: string; subtitle: string; children: (view: CapabilityView) => ReactNode }) {
  const { namespaces } = useSandboxScope()
  const allSandboxes = useSandboxContext(s => s.sandboxes)
  const state = useCapabilities(namespaces ?? [])

  return (
    <>
      <Page>
        <PageHeader icon={icon} title={title} subtitle={subtitle} accessory={<ProvisioningScopePill />} />
        {state.status === "loading" && <LoadingLine loading="cluster support" />}
        {state.status === "not-in-cluster" && <p className="text-sm text-muted-foreground">{NOT_IN_CLUSTER}</p>}
        {state.status === "unauthenticated" && <p className="text-sm text-muted-foreground">Log out and back in to refresh your session.</p>}
        {state.status === "error" && <p className="text-status-major">{state.message}</p>}
        {/* Reads that failed name the rule to add. */}
        {state.status === "ready" && state.capabilities.degraded.map(entry => (
          <p key={entry.source} className="text-sm text-muted-foreground">Not checked: {entry.message}</p>
        ))}
        {state.status === "ready" && children({
          capabilities: state.capabilities,
          scoped: (namespaces ?? []).length > 0,
          sandboxes: allSandboxes.filter(s => (namespaces ?? []).includes(s.namespace)),
        })}
      </Page>
    </>
  )
}
