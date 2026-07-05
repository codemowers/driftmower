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
    const parts = groupKey.split("/")
    if (parts.length < 3) continue
    const uid = usages[0]?.workloadRootInfo?.uid
    if (!uid) continue
    roots.push({ groupKey, kind: parts[0], namespace: parts[1], name: parts[2], uid, usages })
  }
  return roots
}
