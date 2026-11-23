"use client"

import ResourceCommandsCard from "@/app/components/resource-commands-card"

export default function CommandsCard({ kind, namespace, name, apiGroup }: { kind: string; namespace: string; name: string; apiGroup?: string }) {
  return <ResourceCommandsCard kind={kind} namespace={namespace} name={name} apiVersion={apiGroup} />
}
