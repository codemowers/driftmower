import { useClusterState } from "@/lib/cluster/cluster-state"
import { LIVE_PATCH_UPGRADE_APPLY_URL, LIVE_PATCH_UPGRADE_PREVIEW_URL, LIVE_PATCH_UPGRADE_REMOVE_URL } from "@/lib/cluster/constants"
import type { LivePatchUpgradeListResponse, LivePatchUpgradePreviewResponse, LivePatchUpgradeRequest } from "./types"

async function post<T>(url: string, request: LivePatchUpgradeRequest): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
  })
  if (res.ok) return (await res.json()) as T
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? `Request failed with status ${res.status}`)
}

export function previewLivePatchUpgrade(request: LivePatchUpgradeRequest): Promise<LivePatchUpgradePreviewResponse> {
  return post<LivePatchUpgradePreviewResponse>(LIVE_PATCH_UPGRADE_PREVIEW_URL, request)
}

export async function applyLivePatchUpgrade(request: LivePatchUpgradeRequest): Promise<void> {
  useClusterState.setState({ livePatchUpgrades: await post<LivePatchUpgradeListResponse>(LIVE_PATCH_UPGRADE_APPLY_URL, request) })
}

export async function removeLivePatchUpgrade(request: LivePatchUpgradeRequest): Promise<void> {
  useClusterState.setState({ livePatchUpgrades: await post<LivePatchUpgradeListResponse>(LIVE_PATCH_UPGRADE_REMOVE_URL, request) })
}
