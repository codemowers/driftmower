"use client"

import ResourceCommandsCard from "@/app/components/resource-commands-card"

export default function CommandsCard({ namespace, name, ports }: { namespace: string; name: string; ports?: { port: number; protocol: string }[] }) {
  return <ResourceCommandsCard kind="Pod" namespace={namespace} name={name} ports={ports} />
}
