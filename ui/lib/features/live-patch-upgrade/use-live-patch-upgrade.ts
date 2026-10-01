import { useClusterState } from "@/lib/cluster/cluster-state"
import type { ActionFacts } from "@/lib/features/actions/types"
import { fixKey } from "./key"
import type { LivePatchUpgradeRecord } from "./types"

export type LivePatchUpgradeState = {
  available: boolean
  canWrite: boolean
  blockedReason: string | null
  active: LivePatchUpgradeRecord | null
}

const INACTIVE: LivePatchUpgradeState = { available: false, canWrite: false, blockedReason: null, active: null }

export function useLivePatchUpgrade(facts: ActionFacts): LivePatchUpgradeState {
  const livePatchUpgrades = useClusterState(s => s.livePatchUpgrades)
  if (!livePatchUpgrades) return INACTIVE
  const key = fixKey(facts)
  return {
    available: livePatchUpgrades.available,
    canWrite: livePatchUpgrades.canWrite,
    blockedReason: livePatchUpgrades.blockedReason,
    active: livePatchUpgrades.fixes.find(f => f.actionKey === key) ?? null,
  }
}

export function useLivePatchUpgradeCount(): number {
  return useClusterState(s => s.livePatchUpgrades?.fixes.length ?? 0)
}
