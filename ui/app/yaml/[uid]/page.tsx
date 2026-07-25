"use client"

import { useParams } from "next/navigation"
import { FileCode } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { supportsYamlView } from "@/lib/cluster/yaml-supported-kinds"
import ResourceHeader from "@/app/components/resource-header"
import YamlViewer from "./components/yaml-viewer"

export default function YamlPage() {
  const { uid } = useParams<{ uid: string }>()
  const clusterResources = useClusterState(s => s.clusterResources)

  const resource = clusterResources?.find(r => r.uid === uid) ?? null

  if (clusterResources === null) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Loading cluster data…</p>
        </main>
      </div>
    )
  }

  if (!resource) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Resource not found in the live cluster.</p>
        </main>
      </div>
    )
  }

  if (!supportsYamlView(resource.kind) || !resource.namespace) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">
            YAML view is not available for {resource.kind} resources.
          </p>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={FileCode}
          iconAriaLabel="Resource YAML"
          title={resource.name}
          copyValue={resource.name}
          breadcrumbs={[{ label: "YAML" }, { label: `${resource.kind} ${resource.name}` }]}
          chips={[
            { label: resource.kind, tone: "brand" },
            { label: resource.namespace, tone: "muted" },
          ]}
          subtitle="live from the cluster · managedFields omitted"
        />

        <YamlViewer
          uid={resource.uid}
          kind={resource.kind}
          namespace={resource.namespace}
          name={resource.name}
        />
      </main>
    </div>
  )
}
