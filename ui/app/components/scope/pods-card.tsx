"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import Card from "@/app/components/layout/card"
import PodList from "@/app/components/pod-list"
import type { ClusterResource } from "@/lib/cluster/cluster-state"

// Scan visibility is a URL filter so the inventory read can include retained
// completed attempts when the person explicitly asks to see scan Pods.
export default function PodsCard({ pods, resources, workloadUid }: { pods: ClusterResource[] | null; resources?: ClusterResource[] | null; workloadUid?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const tokens = new Set((search.get("filters") ?? "").split(",").filter(Boolean))
  const showScanPods = tokens.has("showscanpods")
  const visible = pods?.filter(pod => showScanPods || !pod.scanPod) ?? null
  const toggleScanPods = () => {
    const nextTokens = new Set(tokens)
    if (showScanPods) nextTokens.delete("showscanpods")
    else nextTokens.add("showscanpods")
    const params = new URLSearchParams(search.toString())
    if (nextTokens.size) params.set("filters", [...nextTokens].join(","))
    else params.delete("filters")
    router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false })
  }
  return (
    <Card flush title="Pods" meta={visible ? visible.length : undefined} actions={
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={showScanPods} onChange={toggleScanPods} />Show scan Pods
      </label>
    }>
      {visible === null
        ? <p className="px-5 py-4 text-sm text-muted-foreground">Loading Pods…</p>
        : visible.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">No Pods found.</p>
        : <PodList bare pods={visible} resources={resources ?? []} workloadUid={workloadUid} />}
    </Card>
  )
}
