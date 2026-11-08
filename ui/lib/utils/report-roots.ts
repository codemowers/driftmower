import type { ImageUsage, Report } from "@/lib/cluster/reports"

export type ReportWorkloadRoot = {
  desiredReplicas?: number
  completed?: boolean
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
  if (data.workloads) {
    for (const workload of data.workloads) {
      const owners = workload.kind === "Namespace"
        ? (workload.standalonePods ?? []).map(pod => ({ ...pod, kind: "Pod", namespace: workload.namespace }))
        : [workload]
      for (const owner of owners) {
        const groupKey = `${owner.kind}/${owner.namespace}/${owner.name}`
        roots.push({ ...owner, groupKey, usages: data.report.workloadGroupMap[groupKey] ?? [] })
      }
    }
    return roots
  }
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
