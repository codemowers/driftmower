import type {
  ActionFacts,
  ActionRow,
  AssessResult,
  ChangeEntry,
  Classification,
  Coverage,
  Relation,
  Risk,
  Value,
} from "./types"

export const VERDICT_LEAD: Record<Risk, string> = {
  safe: "Safe to apply.",
  review: "Review before applying.",
  risky: "Not safe as is.",
}

export const VALUE_LEAD: Record<Value, string> = {
  high: "Worth it",
  medium: "Consider",
  low: "Optional",
}

const EMPTY_CLASSIFICATION: Classification = { breaking: [], security: [], notable: [], affects: [] }
const NONE_COVERAGE: Coverage = { changelog: "none", versionsCovered: 0, versionsTotal: 0, modelUsed: false, configKeysTotal: 0, configKeysSent: 0 }

type Semver = [number, number, number]

export function parseSemver(version: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
}

export function compareSemver(a: Semver, b: Semver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function minorsSkipped(facts: ActionFacts): number {
  const from = parseSemver(facts.from)
  const to = parseSemver(facts.to)
  if (!from || !to || from[0] !== to[0]) return 0
  return to[1] - from[1]
}

export function severeFixableCount(facts: ActionFacts): number {
  return facts.cves.filter(c => c.fixedVersion && (c.severity === "CRITICAL" || c.severity === "HIGH")).length
}

function hasFixableSevereCve(facts: ActionFacts): boolean {
  return severeFixableCount(facts) > 0
}

function followsFloatingTag(facts: ActionFacts): boolean {
  return parseSemver(facts.from) === null
}

export function deriveRisk(facts: ActionFacts, c: Classification, coverage: Coverage): Risk {
  if (facts.kind === "pin-digest") return followsFloatingTag(facts) ? "review" : "safe"
  if (c.breaking.length > 0 || c.affects.some(a => a.effect === "breaks")) return "risky"
  if (facts.drift === "major") return "review"
  if (c.affects.some(a => a.effect === "changes")) return "review"
  if (coverage.changelog === "none" && minorsSkipped(facts) > 1) return "review"
  return "safe"
}

export function deriveValue(facts: ActionFacts, c: Classification): Value {
  if (facts.kind === "pin-digest") return followsFloatingTag(facts) ? "low" : "high"
  if (hasFixableSevereCve(facts) || c.security.length > 0) return "high"
  if (facts.cves.length === 0 && c.security.length === 0 && c.affects.length === 0) return "low"
  return "medium"
}

export function interimVersion(entries: ChangeEntry[], c: Classification, facts: ActionFacts): string | null {
  if (c.breaking.length === 0) return null
  const from = parseSemver(facts.from)
  const to = parseSemver(facts.to)
  if (!from || !to) return null
  const versions = [...new Set(entries.map(e => e.version))]
    .map(v => ({ v, s: parseSemver(v) }))
    .filter((x): x is { v: string; s: Semver } => x.s !== null && compareSemver(x.s, from) > 0 && compareSemver(x.s, to) < 0)
    .sort((a, b) => compareSemver(a.s, b.s))
  const breakingVersions = c.breaking.map(i => parseSemver(entries[i]?.version ?? "")).filter((s): s is Semver => s !== null)
  if (breakingVersions.length === 0) return null
  const firstBreaking = breakingVersions.sort(compareSemver)[0]
  const fixes = facts.cves
    .map(cv => (cv.fixedVersion ? parseSemver(cv.fixedVersion) : null))
    .filter((s): s is Semver => s !== null && compareSemver(s, from) > 0 && compareSemver(s, to) <= 0)
  const candidates = versions.filter(x => compareSemver(x.s, firstBreaking) < 0 && fixes.every(f => compareSemver(x.s, f) >= 0))
  return candidates.length > 0 ? candidates[candidates.length - 1].v : null
}

function plural(n: number, word: string, words = `${word}s`): string {
  return `${n} ${n === 1 ? word : words}`
}

export function verdictText(risk: Risk, facts: ActionFacts, c: Classification, coverage: Coverage, interim: string | null): string {
  if (facts.kind === "pin-digest") {
    return followsFloatingTag(facts)
      ? `This workload follows ${facts.from} by design. Pin ${facts.to} if you want it to stay on this build, or leave it and let the next restart take the new one.`
      : "The tag was rebuilt with the same version, usually for a base image fix. Restart to pick it up, then pin the new digest so it stays put."
  }
  const parts: string[] = []
  const span = facts.kind === "upgrade-chart" ? "chart" : facts.drift === "unknown" ? "version" : facts.drift
  if (coverage.changelog === "none") {
    parts.push(`No release notes found for this ${span} jump; verdict uses version distance and the scan only.`)
  } else {
    const partial = coverage.versionsCovered < coverage.versionsTotal
    const count = (n: number, word: string, words?: string) => `${partial ? "at least " : ""}${plural(n, word, words)}`
    const bits = [
      c.breaking.length > 0 ? count(c.breaking.length, "breaking change") : "no breaking changes",
      c.security.length > 0 ? count(c.security.length, "security fix", "security fixes") : null,
    ].filter(Boolean)
    parts.push(`${capitalize(span)} update with ${bits.join(" and ")}.`)
  }
  const breaks = c.affects.filter(a => a.effect === "breaks").length
  const changes = c.affects.filter(a => a.effect === "changes").length
  if (breaks > 0) parts.push(`${plural(breaks, "setting")} you override must change first.`)
  else if (changes > 0) parts.push(`${plural(changes, "setting")} you override ${changes === 1 ? "is" : "are"} involved but ${changes === 1 ? "keeps" : "keep"} working.`)
  else if (coverage.configKeysTotal > 0) parts.push("Nothing in your values is touched.")
  if (interim) parts.push(`${interim} is the last version before the breaking change.`)
  if (risk === "safe" && facts.cves.length === 0 && c.security.length === 0 && c.affects.length === 0) {
    parts.push("Nothing in it for this deployment beyond staying current.")
  }
  return parts.join(" ")
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export type ReasonContext = { relation: Relation; absorbed: ActionRow[]; displayFrom: string }

function driftBetween(from: string, to: string): string | null {
  const a = parseSemver(from)
  const b = parseSemver(to)
  if (!a || !b) return null
  if (b[0] !== a[0]) return plural(b[0] - a[0], "major")
  if (b[1] !== a[1]) return plural(b[1] - a[1], "minor")
  if (b[2] !== a[2]) return plural(b[2] - a[2], "patch", "patches")
  return null
}

function driftFallback(facts: ActionFacts): string {
  if (facts.kind === "upgrade-chart") return `${facts.drift} chart bump`
  const skipped = minorsSkipped(facts)
  return skipped > 1 ? `${skipped} minor releases skipped` : `${facts.drift} release behind`
}

export function reasonLine(facts: ActionFacts, result: AssessResult | null, ctx?: ReasonContext): string {
  if (!ctx) return baseReason(facts, result)
  if (ctx.absorbed.length > 0) {
    const first = ctx.absorbed[0].facts
    const more = ctx.absorbed.length > 1 ? ` +${ctx.absorbed.length - 1} more` : ""
    const merged = { ...facts, cves: [...facts.cves, ...ctx.absorbed.flatMap(a => a.facts.cves)] }
    return `ships ${first.repository.split("/").pop()} ${first.from} → ${first.to}${more} · ${baseReason(merged, result)}`
  }
  const base = baseReason(facts, result)
  if (ctx.relation === "after-chart") {
    const still = driftBetween(ctx.displayFrom, facts.to)
    const lead = still ? `after the chart upgrade, still ${still} behind` : "after the chart upgrade, still behind"
    return base === driftFallback(facts) ? lead : `${lead} · ${base}`
  }
  if (ctx.relation === "override") return `${base} · the latest chart still pins ${facts.from}`
  return base
}

function baseReason(facts: ActionFacts, result: AssessResult | null): string {
  if (facts.kind === "pin-digest") {
    return followsFloatingTag(facts)
      ? `manifest follows ${facts.from}; a restart would move to the new build`
      : `${facts.from} was rebuilt; running pods are on the old build`
  }
  const severe = facts.cves.filter(c => c.fixedVersion && (c.severity === "CRITICAL" || c.severity === "HIGH"))
  const critical = severe.filter(c => c.severity === "CRITICAL").length
  const high = severe.length - critical
  if (severe.length > 0) {
    const cveBits = [critical > 0 ? `${critical} critical` : null, high > 0 ? `${high} high` : null].filter(Boolean)
    return `closes ${cveBits.join(" and ")} ${severe.length === 1 ? "CVE" : "CVEs"}`
  }
  if (result) {
    const breaks = result.affects.filter(a => a.effect === "breaks").length
    if (breaks > 0) return `${plural(breaks, "setting")} you override removed or renamed`
    if (result.groups.breaking.length > 0) return `${plural(result.groups.breaking.length, "breaking change")} upstream`
    if (result.groups.security.length > 0) return `${plural(result.groups.security.length, "security fix")} upstream`
    if (result.coverage.changelog === "none") return "no release notes found"
    if (result.value === "low") return "fixes and housekeeping only"
  }
  return driftFallback(facts)
}

export function deterministicResult(facts: ActionFacts): AssessResult {
  const risk = deriveRisk(facts, EMPTY_CLASSIFICATION, NONE_COVERAGE)
  return {
    risk,
    value: deriveValue(facts, EMPTY_CLASSIFICATION),
    verdict: verdictText(risk, facts, EMPTY_CLASSIFICATION, NONE_COVERAGE, null),
    entries: [],
    groups: { breaking: [], security: [], notable: [], other: [] },
    affects: [],
    configKeys: [],
    coverage: NONE_COVERAGE,
    sources: [],
    valuesKey: null,
    interim: null,
    chartAppVersions: null,
  }
}
