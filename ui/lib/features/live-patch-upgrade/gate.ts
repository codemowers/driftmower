import type { EnrichedRow } from "@/app/components/actions-chip"

export function livePatchUpgradeEligible(item: EnrichedRow): boolean {
  const { row, result, chip, risk } = item
  return (
    row.facts.kind === "update-image" &&
    row.facts.drift === "patch" &&
    risk === "safe" &&
    chip !== "assessing" &&
    !result?.interim &&
    row.target !== undefined
  )
}
