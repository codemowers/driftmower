"use client"

import PageHeader from "../components/page-header"
import ClusterScopePill from "../components/cluster-scope-pill"
import { StatCaption, StatCell, StatGrid, StatValue } from "../components/stats-card"
import AdmissionList from "./components/admission-list"
import HostCard from "./components/host-card"
import McpPanel from "./components/mcp-panel"
import OfferingList from "./components/offering-list"
import PodSecurityCard from "./components/pod-security-card"
import Section from "./components/section"
import StorageList from "./components/storage-list"
import { useCapabilities } from "@/lib/features/provisioning/use-capabilities"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import type { CapabilityResponse } from "@/lib/features/provisioning/types"

const SUBTITLE =
  "What this cluster will let you deploy, and the rules it enforces. Nothing here changes anything."

const NOT_IN_CLUSTER =
  "Provisioning reads what this cluster supports from the Kubernetes API, which is unavailable when not running in-cluster."

export default function ProvisioningPage() {
  const { namespaces } = useSandboxScope()
  // Namespace-scoped facts are only read for the selected sandbox's namespaces;
  // unscoped, the page still shows everything cluster-wide.
  const state = useCapabilities(namespaces ?? [])

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Provisioning" subtitle={SUBTITLE} accessory={<ClusterScopePill />} />

        {state.status === "loading" && <p className="text-sm text-muted-foreground">Loading cluster support…</p>}

        {state.status === "not-in-cluster" && <p className="text-sm text-muted-foreground">{NOT_IN_CLUSTER}</p>}

        {state.status === "unauthenticated" && (
          <p className="text-sm text-muted-foreground">Log out and back in to refresh your session.</p>
        )}

        {state.status === "error" && <p className="text-status-major">{state.message}</p>}

        {state.status === "ready" && (
          <Ready capabilities={state.capabilities} scoped={(namespaces ?? []).length > 0} />
        )}
      </main>
    </div>
  )
}

function Ready({ capabilities, scoped }: { capabilities: CapabilityResponse; scoped: boolean }) {
  const installed = capabilities.offerings.filter(
    o => o.availability.state === "ready" || o.availability.state === "degraded",
  )
  const zones = capabilities.topology.zones.filter(z => z.zone !== "(no zone label)")
  const enforced = capabilities.admissionPolicies.filter(p => p.enforced)

  return (
    <>
      <StatGrid>
        <StatCell label="Operators installed">
          <StatValue>{installed.length}</StatValue>
          <StatCaption>of {capabilities.offerings.length} known</StatCaption>
        </StatCell>
        <StatCell label="Storage classes">
          <StatValue>{capabilities.storageClasses.length}</StatValue>
          <StatCaption>
            {capabilities.storageClasses.filter(s => s.replicaSafe).length} survive losing a node
          </StatCaption>
        </StatCell>
        <StatCell label="Zones">
          <StatValue>{zones.length}</StatValue>
          <StatCaption>{capabilities.topology.schedulableNodes} schedulable nodes</StatCaption>
        </StatCell>
        <StatCell label="Enforced policies">
          <StatValue>{enforced.length}</StatValue>
          <StatCaption>override your permissions</StatCaption>
        </StatCell>
      </StatGrid>

      {/* Degraded reads name the rule to add, following the habit in
          lib/cluster-resources/nodes.ts. */}
      {capabilities.degraded.length > 0 && (
        <Section title="Not checked" count={capabilities.degraded.length}>
          <div className="flex flex-col gap-2">
            {capabilities.degraded.map(entry => (
              <p key={entry.source} className="text-sm text-muted-foreground">
                {entry.message}
              </p>
            ))}
          </div>
        </Section>
      )}

      {/* Everything above is also available to a coding agent, over one
          authenticated endpoint, alongside the drift analysis. The tool list is
          the easy part; getting a token into a client is what needs showing. */}
      <Section
        title="Connect a coding agent"
        hint="The MCP gateway answers these same questions, scoped to the namespaces you can access. Read-only — it changes nothing."
      >
        <McpPanel />
      </Section>

      <Section
        title="Your hostname"
        hint="The ingress controller is shared, so the hostname you may claim is anchored on your namespace and enforced on admission."
      >
        {scoped ? (
          <HostCard ingress={capabilities.ingress} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Pick a sandbox in the sidebar to see the hostnames its namespaces may claim.
          </p>
        )}
      </Section>

      {/* The offerings the stat tile counts, with the manifest each one takes.
          Same intent as the Ingress snippet above: the answer to "how do I ask
          for one" should be copyable, not reconstructed from operator docs. */}
      <Section
        title="Databases and other operators"
        count={capabilities.offerings.length}
        hint="Each sample is the smallest manifest this cluster would accept, at the API version it actually serves. Sized for trying something out — one replica, a small disk."
      >
        <OfferingList
          offerings={capabilities.offerings}
          storageClasses={capabilities.storageClasses}
          namespace={capabilities.namespaces[0]?.namespace ?? null}
        />
      </Section>

      <Section title="Storage" count={capabilities.storageClasses.length}>
        <StorageList classes={capabilities.storageClasses} />
      </Section>

      <Section
        title="Admission policies"
        count={capabilities.admissionPolicies.length}
        hint="These are checked after your permissions and can reject an apply your role otherwise allows."
      >
        <div className="flex flex-col gap-4">
          {/* Pod Security first: it is enforced by the apiserver rather than by
              a policy object, so it appears in no listing below, and it is the
              rule most likely to reject a first pod. */}
          <PodSecurityCard namespaces={capabilities.namespaces} />
          <AdmissionList policies={capabilities.admissionPolicies} />
        </div>
      </Section>
    </>
  )
}
