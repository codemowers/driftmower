import { kubectlCommand, type KubeconfigConnection } from "../../kubernetes/contexts.ts"
import { shellQuote } from "../../utils/shell.ts"

type Release = { name: string; namespace: string; helmChartRef?: string }
export function uninstallCommand(release: Release, connection?: KubeconfigConnection) {
  if (release.helmChartRef) {
    const [namespace, name] = release.helmChartRef.split("/")
    if (!namespace || !name) return undefined
    return { target: "Rancher HelmChart", command: `${kubectlCommand("delete", connection, namespace)} helmchart.helm.cattle.io ${shellQuote(name)} --ignore-not-found` }
  }
  const context = connection?.aliases?.find(alias => alias.namespace === release.namespace)?.name ?? connection?.name ?? "<context>"
  return { target: "Helm release", command: `helm uninstall ${shellQuote(release.name)} --kube-context ${shellQuote(context)} --namespace ${shellQuote(release.namespace)} --ignore-not-found` }
}
