"use client"

import CapabilitiesPage from "@/app/provisioning/components/capabilities-page"
import ClusterRegistry from "@/app/components/cluster-registry"
import RegistryCard from "@/app/provisioning/components/registry-card"
import Section from "@/app/provisioning/components/section"

// The cluster-wide Zot registry anyone may push to with an API key, and the
// selected sandbox's own registry, whose credentials are already provisioned.
export default function RegistryPage() {
  return (
    <CapabilitiesPage title="Container registry" subtitle="Where to push images: the cluster's shared Zot registry, and your sandbox's own when it runs one.">
      {({ scoped, sandboxes, capabilities }) => (
        <div className="flex flex-col gap-8">
          <ClusterRegistry />
          <Section title="Sandbox registry" hint="A sandbox's private Zot registry, with its pull and push Secret already provisioned.">
            {scoped
              ? <RegistryCard sandboxes={sandboxes} namespaces={capabilities.namespaces} />
              : <p className="text-sm text-muted-foreground">Pick a sandbox in the sidebar to see its registry.</p>}
          </Section>
        </div>
      )}
    </CapabilitiesPage>
  )
}
