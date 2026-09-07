export const YAML_SUPPORTED_KINDS = new Set(["Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet"])

export function supportsYamlView(kind: string): boolean {
  return YAML_SUPPORTED_KINDS.has(kind)
}
