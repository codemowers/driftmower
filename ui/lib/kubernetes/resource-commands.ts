import { kubectlCommand, kubectlResource, type KubeconfigConnection } from "./contexts.ts"
import { shellQuote } from "../utils/shell.ts"

export type ResourceCommand = { label: string; value: string }
export type CommandResource = { kind: string; apiVersion?: string; namespace: string; name: string; ports?: { port: number; protocol: string }[] }

export function resourceCommands(resource: CommandResource, connection?: KubeconfigConnection): ResourceCommand[][] {
  const { kind, namespace, name, ports } = resource
  const token = kubectlResource(kind, resource.apiVersion)
  const target = `${token} ${shellQuote(name)}`
  const kubectl = (verb: string) => kubectlCommand(verb, connection, namespace || undefined)
  const inspect = [
    { label: "get", value: `${kubectl("get")} ${target} -o yaml` },
    ...(kind === "Pod" ? [{ label: "logs", value: `${kubectl("logs")} ${shellQuote(name)} --all-containers=true` }] : []),
    { label: "events", value: `${kubectl("events")} --for ${shellQuote(`${token}/${name}`)}` },
  ]
  const forward = kind === "Pod" ? [...new Set((ports ?? []).filter(port => port.protocol === "TCP").map(port => port.port))].sort((a, b) => a - b).map(port => ({ label: `forward ${port}`, value: `${kubectl("port-forward")} ${shellQuote(`pod/${name}`)} ${port}:${port}` })) : []
  const mutations = [
    ...(["Deployment", "StatefulSet", "DaemonSet"].includes(kind) ? [{ label: "restart", value: `${kubectl("rollout restart")} ${target}` }] : []),
    { label: "delete", value: `${kubectl("delete")} ${target}` },
  ]
  return [inspect, forward, mutations].filter(group => group.length > 0)
}
