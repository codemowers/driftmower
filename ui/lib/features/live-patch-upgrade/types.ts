import type { ActionFacts } from "../actions/types.ts"

export type LivePatchUpgradeTarget = {
  namespace: string
  kind: string
  name: string
  uid: string
}

export type LivePatchUpgradeRequest = {
  facts: ActionFacts
  target: LivePatchUpgradeTarget
  dryRun?: boolean
}

export type PolicyVersion = "v1" | "v1beta1"

export type LivePatchUpgradeRecord = {
  actionKey: string
  namespace: string
}

export type LivePatchUpgradeListResponse = {
  available: boolean
  canWrite: boolean
  fixes: LivePatchUpgradeRecord[]
}

export type LivePatchUpgradePreviewResponse = {
  yaml: string
  name: string
}
