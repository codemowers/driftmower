import type { ImageUsage, Report } from "@/lib/cluster/reports"

export type ReportWorkloadRoot = {
  groupKey: string
  kind: string
  namespace: string
  name: string
  uid: string
  usages: ImageUsage[]
}

export function reportWorkloadRoots(data: Report | null): ReportWorkloadRoot[] {
  if (!data) return []

  const roots: ReportWorkloadRoot[] = []
  for (const [groupKey, usages] of Object.entries(data.report.workloadGroupMap)) {
    if (groupKey === "unknown") continue
    const root = usages[0]?.workloadRootInfo
    if (!root?.uid) continue
    roots.push({
      groupKey,
      kind: root.kind,
      namespace: root.namespace,
      name: root.name,
      uid: root.uid,
      usages,
    })
  }
  return roots
}
