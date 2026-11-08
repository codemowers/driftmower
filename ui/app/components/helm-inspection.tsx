"use client"
import type { ReleaseInfo } from "@/lib/cluster/reports"
import InspectionCommands, { shellQuote as q } from "./inspection-commands"

export default function HelmInspection({ release }: { release: ReleaseInfo }) {
  const commands: { label: string; command: string }[] = []
  if (release.helmChartRef) {
    const [namespace, name] = release.helmChartRef.split("/")
    if (namespace && name) commands.push({ label: "HelmChart declaration", command: `kubectl -n ${q(namespace)} get helmchart.helm.cattle.io ${q(name)} -o yaml` })
  }
  if (release.secretName) commands.push({ label: "Latest release Secret metadata (without Secret data)", command: `kubectl -n ${q(release.namespace)} get secret ${q(release.secretName)} -o jsonpath='{.metadata}'` })
  commands.push({ label: "Release revisions and statuses", command: `kubectl -n ${q(release.namespace)} get secrets -l ${q(`owner=helm,name=${release.name}`)} -o custom-columns=NAME:.metadata.name,REVISION:.metadata.labels.version,STATUS:.metadata.labels.status` })
  return <InspectionCommands commands={commands}/>
}
