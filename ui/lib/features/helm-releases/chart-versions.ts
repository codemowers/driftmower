import type { StatusType } from "@/lib/cluster/reports"

export type CleanedChartTags = { stable: string[]; prerelease: string[] }

const ZERO_DATE_PREFIX = "0001-01-01"

type VersionTuple = [number, number, number]

type ParsedVersion = { tuple: VersionTuple; suffix: string | null }

function parseLoose(tag: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(tag)
  if (!match) return null
  return {
    tuple: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
    suffix: match[4] ?? null,
  }
}

function parseVersion(tag: string): VersionTuple | null {
  const parsed = parseLoose(tag)
  return parsed && parsed.suffix === null ? parsed.tuple : null
}

function compareTuples(a: VersionTuple, b: VersionTuple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function compareParsedDesc(a: ParsedVersion, b: ParsedVersion): number {
  const byTuple = compareTuples(b.tuple, a.tuple)
  if (byTuple !== 0) return byTuple
  if ((a.suffix === null) !== (b.suffix === null)) return a.suffix === null ? -1 : 1
  return (b.suffix ?? "").localeCompare(a.suffix ?? "")
}

export function normalizeChartVersion(tag: string): string {
  return tag.replace(/^v/, "")
}

export function cleanChartTags(tags: string[]): CleanedChartTags {
  const normalized = new Set(tags.map(normalizeChartVersion))
  const stable: { tag: string; parsed: ParsedVersion }[] = []
  const prerelease: { tag: string; parsed: ParsedVersion }[] = []
  for (const tag of normalized) {
    const parsed = parseLoose(tag)
    if (!parsed) continue
    if (parsed.suffix === null) stable.push({ tag, parsed })
    else prerelease.push({ tag, parsed })
  }
  stable.sort((a, b) => compareParsedDesc(a.parsed, b.parsed))
  prerelease.sort((a, b) => compareParsedDesc(a.parsed, b.parsed))
  return { stable: stable.map(s => s.tag), prerelease: prerelease.map(p => p.tag) }
}

export function sortChartVersionsDesc(tags: string[]): string[] {
  return tags
    .map(tag => ({ tag, parsed: parseLoose(tag) }))
    .filter((e): e is { tag: string; parsed: ParsedVersion } => e.parsed !== null)
    .sort((a, b) => compareParsedDesc(a.parsed, b.parsed))
    .map(e => e.tag)
}

export function compareChartVersions(a: string, b: string): number {
  const parsedA = parseLoose(normalizeChartVersion(a))
  const parsedB = parseLoose(normalizeChartVersion(b))
  if (!parsedA || !parsedB) return 0
  return -compareParsedDesc(parsedA, parsedB)
}

export function chartDrift(deployed?: string, latest?: string): StatusType {
  const deployedParsed = deployed ? parseLoose(normalizeChartVersion(deployed)) : null
  const latestParsed = latest ? parseLoose(normalizeChartVersion(latest)) : null
  if (!deployedParsed || !latestParsed) return "no_data"
  const diff = -compareParsedDesc(latestParsed, deployedParsed)
  if (diff === 0) return "up_to_date"
  if (diff < 0) return "ahead"
  if (latestParsed.tuple[0] > deployedParsed.tuple[0]) return "major_behind"
  if (latestParsed.tuple[1] > deployedParsed.tuple[1]) return "minor_behind"
  return "patch_behind"
}

export function stableVersionsBetween(stable: string[], deployed?: string, latest?: string): number {
  const deployedTuple = deployed ? parseVersion(normalizeChartVersion(deployed)) : null
  const latestTuple = latest ? parseVersion(normalizeChartVersion(latest)) : null
  if (!deployedTuple || !latestTuple) return 0
  return stable.filter(tag => {
    const tuple = parseVersion(tag)
    return tuple && compareTuples(tuple, deployedTuple) > 0 && compareTuples(tuple, latestTuple) <= 0
  }).length
}

export function newestPatchOfMinor(stable: string[], deployed?: string): string | null {
  const deployedTuple = deployed ? parseVersion(normalizeChartVersion(deployed)) : null
  if (!deployedTuple) return null
  return (
    stable.find(tag => {
      const tuple = parseVersion(tag)
      return (
        tuple &&
        tuple[0] === deployedTuple[0] &&
        tuple[1] === deployedTuple[1] &&
        tuple[2] > deployedTuple[2]
      )
    }) ?? null
  )
}

export function normalizeDeployDate(value?: string): string | undefined {
  return value && !value.startsWith(ZERO_DATE_PREFIX) ? value : undefined
}
