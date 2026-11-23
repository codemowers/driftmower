import { shellQuote } from "../utils/shell.ts"

export type ContextAlias = { name: string; namespace?: string }
export type KubeconfigConnection = {
	chromeProfile?:{directory:string;name:string}
  key: string
  name: string
  apiServer?: string
  authMethod?: string
  certificate?: boolean
  aliases?: ContextAlias[]
  status: string
  state?: "available" | "auth" | "unreachable" | "other"
  url?: string
  portForward?: boolean
  signIn?: boolean
  signInCommand?: string
}

export function connectionForEndpoint(connections: KubeconfigConnection[], endpoint: string, selectedKey?: string): KubeconfigConnection | undefined {
  const selected = connections.find(connection => connection.key === selectedKey)
  if (selected && (!selected.url || selected.url === endpoint)) return selected
  const matching = connections.filter(connection => connection.url === endpoint)
  // With several identities for one endpoint, do not silently pick the admin
  // certificate. Settings lets the person choose the intended connection.
  return matching.length === 1 ? matching[0] : undefined
}

export function kubectlCommand(verb: string, connection?: KubeconfigConnection, namespace?: string | null): string {
  const targetNamespace = namespace === null
    ? connection?.aliases?.find(alias => alias.name === connection.name)?.namespace || "default"
    : namespace
  const scoped = targetNamespace ? connection?.aliases?.find(alias => alias.namespace === targetNamespace) : undefined
  const context = scoped?.name ?? connection?.name ?? "<context>"
  return `kubectl${verb ? " " + verb : ""} --context ${shellQuote(context)}${targetNamespace && !scoped ? ` --namespace ${shellQuote(targetNamespace)}` : ""}`
}

// Action commands contain a single kubectl invocation and an explicit namespace.
// Their existing -n is replaced rather than relying on the terminal's context.
export function scopeActionCommand(command: string, connection?: KubeconfigConnection): string {
  if (!command.startsWith("kubectl ") || /(?:^|\s)--context(?:=|\s)/.test(command)) return command
  const match = command.match(/\s+(?:-n|--namespace)(?:=|\s+)([a-z0-9-]+)/)
  const namespace = match?.[1]
  const body = match ? command.replace(match[0], "").slice(8) : command.slice(8)
  const [verb, ...rest] = body.split(" ")
  return `${kubectlCommand(verb, connection, namespace)}${rest.length ? " " + rest.join(" ") : ""}`
}

// kubectl accepts a singular kind qualified by its API group. This also
// handles irregular plurals without guessing a CRD's resource name.
export function kubectlResource(kind: string, apiVersion?: string): string {
  const group = apiVersion?.includes("/") ? apiVersion.split("/")[0] : apiVersion
  return `${kind.toLowerCase()}${group && group !== "v1" && group !== "core" ? `.${group}` : ""}`
}
