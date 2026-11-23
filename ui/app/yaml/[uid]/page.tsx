"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { Suspense } from "react"
import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { supportsYamlView } from "@/lib/features/yaml/supported-kinds"
import ResourceHeader from "@/app/components/resource-header"
import YamlViewer from "./components/yaml-viewer"
import ClusterDataPending from "@/app/components/cluster-data-pending"

export default function YamlPage() {
  const { uid } = useParams<{ uid: string }>()
  const clusterResources = useClusterState(s => s.clusterResources)

  const resource = clusterResources?.find(r => r.uid === uid) ?? null

  if (clusterResources === null) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <ClusterDataPending />
        </Page>
      </div>
    )
  }

  if (!resource) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">Resource not found in the live cluster.</p>
        </Page>
      </div>
    )
  }

  if (!supportsYamlView(resource.kind) || !resource.namespace) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">
            YAML view is not available for {resource.kind} resources.
          </p>
        </Page>
      </div>
    )
  }

  return (
    <div className="min-h-full flex flex-col items-center">
      <Page>
        <ResourceHeader
          icon={ICONS.yaml}
          iconAriaLabel="Resource YAML"
          title={resource.name}
          copyValue={resource.name}
          breadcrumbs={[{ label: "YAML" }, { label: `${resource.kind} ${resource.name}` }]}
          chips={[
            { label: resource.kind, tone: "brand" },
            { label: resource.namespace, tone: "muted" },
          ]}
          subtitle="live from the cluster"
        />

        <Suspense>
          <YamlViewer
            uid={resource.uid}
            kind={resource.kind}
            namespace={resource.namespace}
            name={resource.name}
          />
        </Suspense>
      </Page>
    </div>
  )
}
