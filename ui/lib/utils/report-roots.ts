import type { ImageUsage, Report, ReportWorkload, WorkloadDependencies } from "@/lib/cluster/reports"

export type ReportWorkloadRoot = {
  // A standalone Pod, held in its namespace's orphan bucket.
  orphan?: boolean
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
        ? (workload.standalonePods ?? []).map(pod => ({ ...pod, kind: "Pod", namespace: workload.namespace, orphan: true }))
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

// Each namespace's orphan bucket that holds anything besides standalone Pods.
export function orphanBuckets(data: Report | null): ReportWorkload[] {
  return (data?.workloads ?? []).filter(w => w.kind === "Namespace" && (Object.keys(w.orphaned ?? {}).length > 0 || RESOURCE_KINDS.some(k => (w[k.key] ?? []).length > 0)))
}

// Related resources in display order.
export const RESOURCE_KINDS = [
  { key: "services", label: "Services", one: "Service" },
  { key: "ingresses", label: "Ingresses", one: "Ingress" },
  { key: "certificates", label: "Certificates", one: "Certificate" },
  { key: "configmaps", label: "ConfigMaps", one: "ConfigMap" },
  { key: "secrets", label: "Secrets", one: "Secret" },
  { key: "pvcs", label: "PersistentVolumeClaims", one: "PersistentVolumeClaim" },
] as const satisfies readonly { key: keyof WorkloadDependencies; label: string; one: string }[]
