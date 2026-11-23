"use client"

import Card from "./layout/card"
import CommandRow from "./command-row"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import { resourceCommands, type CommandResource } from "@/lib/kubernetes/resource-commands"

export default function ResourceCommandsCard(props: CommandResource) {
  const connection = useKubectlConnection()
  return <Card title="kubectl commands">
    <div className="flex flex-col gap-3 divide-y divide-gray-200">
      {resourceCommands(props, connection).map((commands, index) => <div key={index} className={index ? "flex flex-col gap-2.5 pt-3" : "flex flex-col gap-2.5"}>
        {commands.map(command => <CommandRow key={command.label} {...command} />)}
      </div>)}
    </div>
  </Card>
}
