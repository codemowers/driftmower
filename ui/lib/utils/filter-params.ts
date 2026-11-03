import type { StatusType } from "@/lib/cluster/reports"

const STATUS_TOKEN: [string, StatusType][] = [
  ["ok", "up_to_date"],
  ["patch", "patch_behind"],
  ["minor", "minor_behind"],
  ["major", "major_behind"],
  ["ahead", "ahead"],
  ["nodata", "no_data"],
]

export function parseFilterTokens(value: string | null): Set<string> {
  return new Set(value?.split(",").filter(Boolean) ?? [])
}

export function statusesFromTokens(tokens: Set<string>): Set<StatusType> {
  return new Set(STATUS_TOKEN.filter(([token]) => tokens.has(token)).map(([, status]) => status))
}

export function statusTokens(active: Set<StatusType>): string[] {
  return STATUS_TOKEN.filter(([, status]) => active.has(status)).map(([token]) => token)
}
