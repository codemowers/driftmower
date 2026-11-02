"use client"

import PageHeader from "../components/page-header"
import ProvisioningScopePill from "./components/scope-pill"
import { StatCaption, StatCell, StatGrid, StatValue } from "../components/stats-card"
import AccessCard from "./components/access-card"
import AdmissionList from "./components/admission-list"
import HostCard from "./components/host-card"
import McpPanel from "./components/mcp-panel"
import OfferingList from "./components/offering-list"
import PodSecurityCard from "./components/pod-security-card"
import RegistryCard from "./components/registry-card"
import Section from "./components/section"
import StorageList from "./components/storage-list"
import { usePageSections, type PageSection } from "@/lib/hooks/use-page-sections"
import { useCapabilities } from "@/lib/features/provisioning/use-capabilities"
import { useSandboxContext, useSandboxScope, type SandboxInfo } from "@/lib/tenancy/sandbox-context"
import type { CapabilityResponse } from "@/lib/features/provisioning/types"
import LoadingLine from "@/app/components/loading-line"

const SUBTITLE =
  "What this cluster will let you deploy, and the rules it enforces. Nothing here changes anything."

const NOT_IN_CLUSTER =
  "Provisioning reads what this cluster supports through driftmower-mcp, which reported that it is not running in a cluster."

export default function ProvisioningPage() {
  const { namespaces } = useSandboxScope()
  const allSandboxes = useSandboxContext(s => s.sandboxes)
  const inScope = allSandboxes.filter(s => (namespaces ?? []).includes(s.namespace))
  // Namespace-scoped facts are only read for the selected sandbox's namespaces;
  // unscoped, the page still shows everything cluster-wide.
  const state = useCapabilities(namespaces ?? [])

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Provisioning" subtitle={SUBTITLE} accessory={<ProvisioningScopePill />} />

        {state.status === "loading" && <LoadingLine loading="cluster support" />}

        {state.status === "not-in-cluster" && <p className="text-sm text-muted-foreground">{NOT_IN_CLUSTER}</p>}

        {state.status === "unauthenticated" && (
          <p className="text-sm text-muted-foreground">Log out and back in to refresh your session.</p>
        )}

        {state.status === "error" && <p className="text-status-major">{state.message}</p>}

        {state.status === "ready" && (
          <Ready capabilities={state.capabilities} scoped={(namespaces ?? []).length > 0} sandboxes={inScope} />
        )}
      </main>
    </div>
  )
}

function Ready({
  capabilities,
  scoped,
  sandboxes,
}: {
  capabilities: CapabilityResponse
  scoped: boolean
  sandboxes: SandboxInfo[]
}) {
  // Only count offerings whose controller is actually running. A served CRD
  // on its own (or a Deployment with no ready replicas) must not make a
  // database look available on the provisioning page.
  const runningOfferings = capabilities.offerings.filter(o => o.availability.state === "ready")
  const zones = capabilities.topology.zones.filter(z => z.zone !== "(no zone label)")
  const enforced = capabilities.admissionPolicies.filter(p => p.enforced)

  // Listed under Provisioning in the nav bar. Mirrors the render conditions
  // below so the list never links to a section that is not on the page.
  const sections: PageSection[] = [
    ...(capabilities.degraded.length > 0 ? [{ id: "not-checked", title: "Not checked" }] : []),
    ...(scoped ? [{ id: "access", title: "Your access" }] : []),
    { id: "coding-agent", title: "Connect a coding agent" },
    { id: "hostname", title: "Your hostname" },
    ...(scoped ? [{ id: "registry", title: "Container registry" }] : []),
    { id: "operators", title: "Databases and other operators" },
    { id: "storage", title: "Storage" },
    { id: "admission", title: "Admission policies" },
  ]
  usePageSections("/provisioning", sections)

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <StatGrid>
        <StatCell label="Operators installed">
          <StatValue>{runningOfferings.length}</StatValue>
          <StatCaption>running and ready</StatCaption>
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

      {/* The cluster authorizer, asked as you, does not let you see these, so
          nothing about them is shown; that is about your access, not whether
          they exist. */}
      {capabilities.withheld.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Not shown, because Kubernetes does not let you list pods there:{" "}
          {capabilities.withheld.map((name, index) => (
            <span key={name}>
              {index > 0 && ", "}
              <code className="font-mono text-xs text-brand-label">{name}</code>
            </span>
          ))}
          .
        </p>
      )}

      {/* Degraded reads name the rule to add. */}
      {capabilities.degraded.length > 0 && (
        <Section id="not-checked" title="Not checked" count={capabilities.degraded.length}>
          <div className="flex flex-col gap-2">
            {capabilities.degraded.map(entry => (
              <p key={entry.source} className="text-sm text-muted-foreground">
                {entry.message}
              </p>
            ))}
          </div>
        </Section>
      )}

      {scoped && (
        <Section
          id="access"
          title="Your access"
          hint="Asked of the cluster as you, for every resource type it serves. Admission policies can still reject an apply these permissions allow."
        >
          <AccessCard namespaces={capabilities.namespaces} />
        </Section>
      )}

      {/* Everything above is also available to a coding agent, over one
          authenticated endpoint, alongside the drift analysis. The tool list is
          the easy part; getting a token into a client is what needs showing. */}
      <Section
        id="coding-agent"
        title="Connect a coding agent"
        hint="The MCP gateway answers these same questions, scoped to the namespaces you can access. Read-only — it changes nothing."
      >
        <McpPanel />
      </Section>

      <Section
        id="hostname"
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

      {scoped && (
        <Section
          id="registry"
          title="Container registry"
          hint="Your sandbox's private Zot registry, with commands for pushing and pulling images."
        >
          <RegistryCard sandboxes={sandboxes} namespaces={capabilities.namespaces} />
        </Section>
      )}

      {/* The offerings the stat tile counts, with the manifest each one takes.
          Same intent as the Ingress snippet above: the answer to "how do I ask
          for one" should be copyable, not reconstructed from operator docs. */}
      <Section
        id="operators"
        title="Databases and other operators"
        count={runningOfferings.length}
        hint="Each sample is the smallest manifest this cluster would accept, at the API version it actually serves. Sized for trying something out — one replica, a small disk."
      >
        <OfferingList
          offerings={runningOfferings}
          storageClasses={capabilities.storageClasses}
          namespace={capabilities.namespaces[0]?.namespace ?? null}
          sandboxId={capabilities.namespaces[0]?.tenant?.id ?? capabilities.namespaces[0]?.sandbox ?? null}
          verdicts={capabilities.namespaces[0]?.offerings ?? null}
        />
      </Section>

      <Section id="storage" title="Storage" count={capabilities.storageClasses.length}>
        <StorageList classes={capabilities.storageClasses} />
      </Section>

      <Section
        id="admission"
        title="Admission policies"
        count={capabilities.admissionPolicies.length}
        hint="Checked after your permissions: a policy rejects an invalid apply with an explanation, even when your role allows it."
      >
        <div className="flex flex-col gap-4">
          {/* Pod Security first: it is enforced by the apiserver rather than by
              a policy object, so it appears in no listing below, and it is the
              rule most likely to reject a first pod. */}
          <PodSecurityCard namespaces={capabilities.namespaces} />
          <AdmissionList policies={capabilities.admissionPolicies} />
        </div>
      </Section>
    </div>
  )
}
