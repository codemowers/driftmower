"use client"
import { uninstallCommand } from "@/lib/features/helm-releases/commands"
import CommandSnippet from "./command-snippet"
import { useKubectl, useKubectlConnection } from "@/lib/hooks/use-kubectl"
import type { ReleaseInfo } from "@/lib/cluster/reports"
import InspectionCommands, { shellQuote as q } from "./inspection-commands"

export default function HelmInspection({ release }: { release: ReleaseInfo }) {
  const kubectl = useKubectl()
  const connection = useKubectlConnection()
  const remove = uninstallCommand(release, connection)
  const commands: { label: string; command: string }[] = []
  if (release.helmChartRef) {
    const [namespace, name] = release.helmChartRef.split("/")
    if (namespace && name) commands.push({ label: "HelmChart declaration", command: `${kubectl("get", namespace)} helmchart.helm.cattle.io ${q(name)} -o yaml` })
  }
  if (release.secretName) commands.push({ label: "Latest release Secret metadata (without Secret data)", command: `${kubectl("get", release.namespace)} secret ${q(release.secretName)} -o jsonpath='{.metadata}'` })
  commands.push({ label: "Release revisions and statuses", command: `${kubectl("get", release.namespace)} secrets -l ${q(`owner=helm,name=${release.name}`)} -o custom-columns=NAME:.metadata.name,REVISION:.metadata.labels.version,STATUS:.metadata.labels.status` })
  return <>
    <InspectionCommands commands={commands}/>
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Uninstall release</h2>
      <p className="text-sm text-muted-foreground">{release.helmChartRef ? "Managed by the Rancher Helm controller. Delete the HelmChart resource to uninstall the release." : "No Rancher HelmChart was found for this release. Uninstall it with Helm."}</p>
      {remove && <CommandSnippet title={`Delete ${remove.target}`} command={remove.command} open/>}
    </section>
  </>
}
