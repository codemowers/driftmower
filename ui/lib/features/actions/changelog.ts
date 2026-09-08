import "server-only"

import type { ActionFacts, ChangeEntry, ChartAppVersions, Coverage } from "@/lib/features/actions/types"
import { compareSemver, parseSemver } from "@/lib/features/actions/verdict"

const SUCCESS_TTL_MS = 60 * 60 * 1000
const FAILURE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const GITHUB_FETCH_TIMEOUT_MS = 20000
const GITHUB_PAGE_SIZE = 50
const ENTRY_CAP = 30
const ENTRY_MAX_CHARS = 300
const GITHUB_MAX_PAGES = 6
const ARTIFACT_HUB_MAX_VERSIONS = 12
const ARTIFACT_HUB_CONCURRENCY = 3

export type Changelog = {
  entries: ChangeEntry[]
  pretagBreaking: number[]
  pretagSecurity: number[]
  prekinded: boolean
  source: Coverage["changelog"]
  versionsCovered: number
  versionsTotal: number
  sources: { label: string; url: string }[]
  chartAppVersions: ChartAppVersions | null
}

type RawEntry = ChangeEntry & { tag: "breaking" | "security" | null; order: number }

const cache = new Map<string, { value: Changelog | null; at: number }>()

const EMPTY: Changelog = { entries: [], pretagBreaking: [], pretagSecurity: [], prekinded: false, source: "none", versionsCovered: 0, versionsTotal: 0, sources: [], chartAppVersions: null }

const GITHUB_API = "https://api.github.com/"
const RATE_LIMIT_FALLBACK_MS = 60 * 1000

export class GithubRateLimitedError extends Error {
  readonly resetAt: number

  constructor(resetAt: number) {
    super(`GitHub rate limit reached, resets at ${new Date(resetAt).toISOString()}`)
    this.name = "GithubRateLimitedError"
    this.resetAt = resetAt
  }
}

let githubResetAt = 0

export async function resolveChangelog(facts: ActionFacts): Promise<Changelog> {
  const key = facts.kind === "upgrade-chart"
    ? `chart:${facts.chart?.repoUrl ?? facts.chart?.source}/${facts.chart?.name}|${facts.from}|${facts.to}`
    : `image:${facts.repository}|${facts.sourceRepoUrl}|${facts.from}|${facts.to}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < (cached.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) return cached.value ?? EMPTY
  try {
    const value = facts.kind === "upgrade-chart" ? await artifactHubChangelog(facts) : await githubChangelog(facts)
    cache.set(key, { value, at: Date.now() })
    return value ?? EMPTY
  } catch (e) {
    if (e instanceof GithubRateLimitedError) throw e
    console.warn(`[actions] changelog failed for ${key}:`, (e as Error).message)
    cache.set(key, { value: null, at: Date.now() })
    return EMPTY
  }
}

function rateLimitReset(res: Response): number | null {
  if (res.status !== 403 && res.status !== 429) return null
  const retryAfter = Number(res.headers.get("retry-after"))
  if (retryAfter > 0) return Date.now() + retryAfter * 1000
  if (res.headers.get("x-ratelimit-remaining") !== "0") return null
  const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000
  return reset > Date.now() ? reset : Date.now() + RATE_LIMIT_FALLBACK_MS
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const github = url.startsWith(GITHUB_API)
  if (github && Date.now() < githubResetAt) throw new GithubRateLimitedError(githubResetAt)
  const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    const resetAt = github ? rateLimitReset(res) : null
    if (resetAt !== null) {
      githubResetAt = resetAt
      throw new GithubRateLimitedError(resetAt)
    }
    throw new Error(`${url} -> ${res.status}`)
  }
  return (await res.json()) as T
}

function inRange(version: string, from: string, to: string): boolean {
  const v = parseSemver(version)
  const a = parseSemver(from)
  const b = parseSemver(to)
  return !!v && !!a && !!b && compareSemver(v, a) > 0 && compareSemver(v, b) <= 0
}

function normalizeTag(tag: string): string | null {
  const match = /(\d+[._]\d+(?:[._]\d+)?(?:-[0-9A-Za-z.]+)?)$/.exec(tag)
  return match ? match[1].replace(/_/g, ".") : null
}

function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "), head.lastIndexOf(": "), head.lastIndexOf(", "))
  const kept = cut > max / 2 ? head.slice(0, cut + (head[cut] === "." ? 1 : 0)) : head.slice(0, head.lastIndexOf(" "))
  return `${kept.replace(/[\s,;:]+$/, "").replace(/\s+(and|or|but|with|to|of|the|a)$/i, "")}${kept.endsWith(".") ? "" : "…"}`
}

export function cleanEntryText(raw: string): string | null {
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
    .replace(/\\/g, "")
    .replace(/#\d+/g, "")
    .replace(/\bby @[\w-]+/g, "")
    .replace(/@[\w-]+/g, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\(\s*(?:[\/,;]\s*)*\)/g, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/[\s,;:]+$/, "")
    .replace(/\s*[([]\s*$/, "")
    .replace(/\s+(in|by|and|or|but|with|to|of|the|a|for|from|via|on|at)$/i, "")
    .replace(/[\s,;:]+$/, "")
    .trim()
  if (text.length < 8) return null
  return truncateAtBoundary(text, ENTRY_MAX_CHARS)
}

function pretag(text: string, inBreakingSection: boolean): RawEntry["tag"] {
  if (/CVE-\d{4}-\d+|security|vulnerab|GHSA-/i.test(text)) return "security"
  if (inBreakingSection || /\bbreaking\b|\bremoved?\b.*\b(flag|option|setting|support|api|field)\b|\bno longer supported\b/i.test(text)) return "breaking"
  return null
}

function splitBody(body: string, version: string, url: string, startOrder: number): RawEntry[] {
  const entries: RawEntry[] = []
  let inBreaking = false
  let order = startOrder
  for (const line of body.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s*(.+)$/.exec(line)
    if (heading) {
      inBreaking = /breaking|upgrade notes|migration/i.test(heading[1])
      continue
    }
    if (!/^\s*(?:[-*+•]|\d+[.)])\s+/.test(line)) continue
    const text = cleanEntryText(line)
    if (!text) continue
    entries.push({ text, version, url, tag: pretag(text, inBreaking), order: order++ })
  }
  return entries
}

function finalize(raw: RawEntry[], source: Coverage["changelog"], versionsTotal: number, sources: Changelog["sources"], prekinded: boolean): Changelog {
  const seen = new Set<string>()
  const deduped = raw.filter(e => {
    const k = e.text.toLowerCase().replace(/\s*\(enterprise\)$/, "")
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const tagged = deduped.filter(e => e.tag !== null).slice(0, ENTRY_CAP)
  const byVersion = new Map<string, RawEntry[]>()
  for (const e of deduped) {
    if (e.tag !== null) continue
    const list = byVersion.get(e.version)
    if (list) list.push(e)
    else byVersion.set(e.version, [e])
  }
  const versionsNewestFirst = [...byVersion.keys()].sort((a, b) => compareSemver(parseSemver(b) ?? [0, 0, 0], parseSemver(a) ?? [0, 0, 0]))
  const picked: RawEntry[] = [...tagged]
  for (let round = 0; picked.length < ENTRY_CAP; round++) {
    let took = false
    for (const version of versionsNewestFirst) {
      const entry = byVersion.get(version)?.[round]
      if (!entry || picked.length >= ENTRY_CAP) continue
      picked.push(entry)
      took = true
    }
    if (!took) break
  }
  const kept = picked.sort((a, b) => a.order - b.order)
  return {
    entries: kept.map(({ text, version, url }) => ({ text, version, url })),
    pretagBreaking: kept.flatMap((e, i) => (e.tag === "breaking" ? [i] : [])),
    pretagSecurity: kept.flatMap((e, i) => (e.tag === "security" ? [i] : [])),
    prekinded,
    source: kept.length > 0 ? source : "none",
    versionsCovered: new Set(kept.map(e => e.version)).size,
    versionsTotal,
    sources,
    chartAppVersions: null,
  }
}

type GithubRelease = { tag_name: string; html_url: string; body: string | null; draft: boolean; prerelease: boolean }

const REPO_OVERRIDES: Record<string, string> = {
  "quay.io/jetstack": "cert-manager/cert-manager",
  "quay.io/cilium": "cilium/cilium",
  "quay.io/prometheus-operator": "prometheus-operator/prometheus-operator",
  "docker.io/prom": "prometheus",
  "docker.io/woodpeckerci": "woodpecker-ci/woodpecker",
  "docker.io/etherpad": "ether/etherpad-lite",
  "docker.io/opensearchproject": "opensearch-project/opensearch-k8s-operator",
  "docker.io/emqx": "emqx/emqx-operator",
  "docker.io/library/rabbitmq": "rabbitmq/rabbitmq-server",
  "docker.io/library/traefik": "traefik/traefik",
  "docker.gitea.com/gitea": "go-gitea/gitea",
  "docker.redpanda.com/redpandadata": "redpanda-data",
  "docker.dragonflydb.io/dragonflydb/operator": "dragonflydb/dragonfly-operator",
  "mirror.gcr.io/aquasec": "aquasecurity",
  "ghcr.io/immich-app": "immich-app/immich",
  "ghcr.io/topolvm": "topolvm/topolvm",
  "reg.kyverno.io/kyverno": "kyverno/kyverno",
  "registry.k8s.io/kube-state-metrics": "kubernetes/kube-state-metrics",
  "registry.k8s.io/nfd": "kubernetes-sigs/node-feature-discovery",
}

function githubRepoFromUrl(url: string | null | undefined): string | null {
  const match = url ? /github\.com\/([^/]+)\/([^/#?]+)/.exec(url) : null
  return match ? `${match[1]}/${match[2].replace(/\.git$/, "")}` : null
}

function githubCandidates(facts: ActionFacts): string[] {
  const out: string[] = []
  const add = (repo: string | null) => {
    if (repo && !out.includes(repo)) out.push(repo)
  }
  add(githubRepoFromUrl(facts.sourceRepoUrl))
  const [host, ...rest] = facts.repository.split("/")
  const org = rest.length > 1 ? rest[0] : "library"
  const name = rest[rest.length - 1]
  const override = REPO_OVERRIDES[`${host}/${rest.join("/")}`] ?? REPO_OVERRIDES[`${host}/${org}`]
  if (override) add(override.includes("/") ? override : `${override}/${name}`)
  if (org === "library") add(`${name}/${name}`)
  else {
    add(`${org}/${name}`)
    add(`${org}/${org}`)
  }
  return out
}

function tagPrefix(tag: string): string {
  const match = /^(.*?)[/\-_]?v?\d+[._]\d+/.exec(tag)
  return (match?.[1] ?? "").replace(/[/\-_]$/, "")
}

function prefixMatches(prefix: string, name: string): boolean {
  return prefix === name || name.endsWith(`-${prefix}`) || prefix.endsWith(`/${name}`) || prefix.endsWith(`-${name}`)
}

async function githubReleases(repo: string, facts: ActionFacts): Promise<Changelog | null> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "driftmower-ui" }
  const token = process.env.GITHUB_TOKEN?.trim()
  if (token) headers.authorization = `Bearer ${token}`
  const from = parseSemver(facts.from)
  const repoPath = repo.split("/").map(encodeURIComponent).join("/")
  const releases: GithubRelease[] = []
  for (let page = 1; page <= GITHUB_MAX_PAGES; page++) {
    let batch: GithubRelease[]
    try {
      batch = await fetchJson<GithubRelease[]>(`https://api.github.com/repos/${repoPath}/releases?per_page=${GITHUB_PAGE_SIZE}&page=${page}`, headers, GITHUB_FETCH_TIMEOUT_MS)
    } catch (e) {
      if ((e as Error).message.endsWith("-> 404")) return null
      throw e
    }
    releases.push(...batch)
    const oldest = batch.at(-1)
    const oldestVersion = oldest ? parseSemver(normalizeTag(oldest.tag_name) ?? "") : null
    if (batch.length < GITHUB_PAGE_SIZE || !from || (oldestVersion && compareSemver(oldestVersion, from) <= 0)) break
  }
  const name = facts.repository.split("/").pop() ?? ""
  const targetIsPrerelease = facts.to.includes("-")
  const tagged = releases
    .filter(r => !r.draft && (targetIsPrerelease || !r.prerelease))
    .map(r => ({ r, prefix: tagPrefix(r.tag_name), version: normalizeTag(r.tag_name) }))
    .filter(t => targetIsPrerelease || !t.version?.includes("-"))
  const matching = tagged.filter(t => t.prefix && prefixMatches(t.prefix, name))
  const unprefixed = tagged.filter(t => !t.prefix)
  const pool = matching.length > 0 ? matching : unprefixed.length > 0 ? unprefixed : tagged
  const target = parseSemver(facts.to)
  if (!target || !pool.some(t => t.version && compareSemver(parseSemver(t.version) ?? [-1, 0, 0], target) === 0)) return null
  const inSpan = pool
    .filter((x): x is { r: GithubRelease; prefix: string; version: string } => !!x.version && inRange(x.version, facts.from, facts.to))
    .sort((a, b) => compareSemver(parseSemver(a.version)!, parseSemver(b.version)!))
  let order = 0
  const raw: RawEntry[] = []
  for (const { r, version } of [...inSpan].reverse()) {
    const entries = splitBody(r.body ?? "", version, r.html_url, order)
    order += entries.length
    raw.push(...entries)
  }
  return finalize(raw, "github", inSpan.length, [{ label: "GitHub releases", url: `https://github.com/${repo}/releases` }], false)
}

async function githubChangelog(facts: ActionFacts): Promise<Changelog | null> {
  for (const repo of githubCandidates(facts)) {
    const found = await githubReleases(repo, facts)
    if (found) return found
  }
  return null
}

type HubSearch = { packages: { name: string; repository: { name: string; url: string; official?: boolean; verified_publisher?: boolean } }[] }
type HubPackage = { available_versions: { version: string; app_version?: string }[]; home_url?: string; links?: { url: string }[]; repository?: { url?: string } }
type HubVersion = { changes?: { kind?: string; description: string }[] }

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/^oci:\/\//, "").replace(/^https?:\/\//, "").replace(/\/index\.yaml$/, "").replace(/\/+$/, "").toLowerCase()
}

async function artifactHubChangelog(facts: ActionFacts): Promise<Changelog | null> {
  const chart = facts.chart
  if (!chart) return null
  const base = process.env.ARTIFACT_HUB_BASE_URL ?? "https://artifacthub.io/api/v1"
  const search = await fetchJson<HubSearch>(`${base}/packages/search?kind=0&ts_query_web=${encodeURIComponent(chart.name)}&limit=20`)
  const wanted = chart.repoUrl ? normalizeRepoUrl(chart.repoUrl) : chart.source ? normalizeRepoUrl(chart.source.replace(/\/[^/]+$/, "")) : null
  const byName = search.packages.filter(p => p.name === chart.name)
  const sameRepo = (url: string) => {
    const theirs = normalizeRepoUrl(url)
    return !!wanted && (theirs.startsWith(wanted) || wanted.startsWith(theirs))
  }
  const pkg = byName.find(p => sameRepo(p.repository.url))
    ?? byName.find(p => p.repository.official)
    ?? byName.find(p => p.repository.verified_publisher)
    ?? (byName.length === 1 ? byName[0] : undefined)
  if (!pkg) return null
  const repoName = pkg.repository.name
  const hubPath = `${encodeURIComponent(repoName)}/${encodeURIComponent(chart.name)}`
  const detail = await fetchJson<HubPackage>(`${base}/packages/helm/${hubPath}`)
  const chartAppVersions: ChartAppVersions = { from: hubAppVersion(detail, facts.from), to: hubAppVersion(detail, facts.to) }
  const versions = detail.available_versions
    .map(v => v.version)
    .filter(v => inRange(v, facts.from, facts.to))
    .sort((a, b) => compareSemver(parseSemver(b)!, parseSemver(a)!))
  const picked = versions.slice(0, ARTIFACT_HUB_MAX_VERSIONS)
  const perVersion = new Map<string, HubVersion>()
  for (let i = 0; i < picked.length; i += ARTIFACT_HUB_CONCURRENCY) {
    const slice = picked.slice(i, i + ARTIFACT_HUB_CONCURRENCY)
    const results = await Promise.all(slice.map(v => fetchJson<HubVersion>(`${base}/packages/helm/${hubPath}/${encodeURIComponent(v)}`).catch(() => null)))
    results.forEach((r, j) => { if (r) perVersion.set(slice[j], r) })
  }
  let order = 0
  const raw: RawEntry[] = []
  for (const version of picked) {
    const url = `https://artifacthub.io/packages/helm/${repoName}/${chart.name}/${version}`
    for (const change of perVersion.get(version)?.changes ?? []) {
      const text = cleanEntryText(change.description)
      if (!text) continue
      const kind = change.kind?.toLowerCase()
      const tag: RawEntry["tag"] = kind === "security" ? "security" : kind === "removed" || kind === "deprecated" ? "breaking" : pretag(text, false)
      raw.push({ text, version, url, tag, order: order++ })
    }
  }
  const hubSource = { label: "Artifact Hub", url: `https://artifacthub.io/packages/helm/${repoName}/${chart.name}` }
  if (raw.length === 0) {
    const links = [detail.home_url, ...(detail.links ?? []).map(l => l.url), detail.repository?.url]
    const repo = links.map(githubRepoFromUrl).find(Boolean)
    const fromGithub = repo ? await githubReleases(repo, facts) : null
    if (fromGithub) return { ...fromGithub, sources: [...fromGithub.sources, hubSource], chartAppVersions }
  }
  const prekinded = raw.length > 0 && [...perVersion.values()].every(v => (v.changes ?? []).every(c => !!c.kind))
  return { ...finalize(raw, "artifacthub", versions.length, [hubSource], prekinded), chartAppVersions }
}

function hubAppVersion(detail: HubPackage, chartVersion: string): string | null {
  const wanted = parseSemver(chartVersion)
  if (!wanted) return null
  const match = detail.available_versions.find(v => {
    const s = parseSemver(v.version)
    return s !== null && compareSemver(s, wanted) === 0
  })
  return match?.app_version ?? null
}
