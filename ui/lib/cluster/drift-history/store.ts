import type { StatusType } from "@/lib/cluster/reports"
import { HISTORY_SEVERITY } from "@/lib/cluster/status-style"
import { IMAGE_USAGE_CHANGES_URL, REPORTS_URL } from "@/lib/cluster/constants"
import { fetchJson } from "@/lib/utils/fetch-json"
import type { Observation, SeriesSource } from "./build-series"
import { seriesKey } from "./build-series"
import type { RottennessPoint } from "./types"

const PAGE_SIZE = 100

type Envelope<T> = { total: number; data: T[] }

type ReportRow = {
  id: string
  createdAt: string
  summaryNormalizedScore: number | null
  summaryTotalContainers: number | null
}

type ChangeRow = {
  reportId: string
  changeType: "appeared" | "disappeared" | "changed"
  workloadGroupKey: string
  registry: string
  repository: string
  digest: string | null
  versionStatus: StatusType | null
  deployedTag: string | null
  latestTag: string | null
  containerCount: number
}

export type DriftHistoryData = {
  timeline: number[]
  reportTimes: Map<string, number>
  rottenness: RottennessPoint[]
  sources: SeriesSource[]
}

// Backend timestamps are UTC "YYYY-MM-DD HH:MM:SS".
function parseBackendDate(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}Z`)
}

function fetchPage<T>(path: string, params: URLSearchParams, skip: number): Promise<Envelope<T>> {
  const page = new URLSearchParams(params)
  page.set("$limit", String(PAGE_SIZE))
  page.set("$skip", String(skip))
  return fetchJson<Envelope<T>>(`${path}?${page}`)
}

async function fetchAll<T>(path: string, params: URLSearchParams): Promise<T[]> {
  const first = await fetchPage<T>(path, params, 0)
  if (first.data.length === 0 || first.total <= PAGE_SIZE) return first.data

  const skips: number[] = []
  for (let skip = PAGE_SIZE; skip < first.total; skip += PAGE_SIZE) skips.push(skip)
  const rest = await Promise.all(skips.map(skip => fetchPage<T>(path, params, skip)))

  return [...first.data, ...rest.flatMap(page => page.data)]
}

function loadReports(context: string): Promise<ReportRow[]> {
  const params = new URLSearchParams({ clusterContext: context })
  params.append("$sort[createdAt]", "1")
  for (const field of ["id", "createdAt", "summaryNormalizedScore", "summaryTotalContainers"]) {
    params.append("$select[]", field)
  }
  return fetchAll<ReportRow>(REPORTS_URL, params)
}

function loadChanges(): Promise<ChangeRow[]> {
  const params = new URLSearchParams()
  params.append("$sort[createdAt]", "1")
  return fetchAll<ChangeRow>(IMAGE_USAGE_CHANGES_URL, params)
}

// Group keys are "Kind/namespace/name"; a name may contain slashes.
function splitGroupKey(groupKey: string): { kind: string; namespace: string; name: string } {
  const [kind = "", namespace = "", ...rest] = groupKey.split("/")
  return { kind, namespace, name: rest.join("/") }
}

type LiveState = {
  status: StatusType
  deployedTag: string | null
  latestTag: string | null
  containerCount: number
}

type SeriesBuild = {
  source: SeriesSource
  live: Map<string, LiveState>
}

function buildSource(row: ChangeRow): SeriesSource {
  const { kind, namespace, name } = splitGroupKey(row.workloadGroupKey)
  return {
    key: seriesKey(row.workloadGroupKey, row.registry, row.repository),
    registry: row.registry,
    repository: row.repository,
    workloadGroupKey: row.workloadGroupKey,
    workloadKind: kind,
    workloadName: name,
    workloadNamespace: namespace,
    observations: [],
    byDigest: new Map(),
  }
}

function digestKey(digest: string | null): string {
  return digest ?? ""
}

function rollUp(live: Map<string, LiveState>): LiveState | null {
  let worst: LiveState | null = null
  let containerCount = 0

  for (const state of live.values()) {
    containerCount += state.containerCount
    if (!worst || HISTORY_SEVERITY[state.status] > HISTORY_SEVERITY[worst.status]) worst = state
  }

  return worst ? { ...worst, containerCount } : null
}

// Transitions only, so state holds until the next one is recorded.
function replay(changes: ChangeRow[], reports: ReportRow[]): SeriesSource[] {
  const reportTimes = new Map(reports.map(report => [report.id, parseBackendDate(report.createdAt)]))
  const byReport = new Map<string, ChangeRow[]>()
  for (const row of changes) {
    const bucket = byReport.get(row.reportId)
    if (bucket) bucket.push(row)
    else byReport.set(row.reportId, [row])
  }

  const builds = new Map<string, SeriesBuild>()

  for (const report of reports) {
    const t = reportTimes.get(report.id)
    if (t === undefined) continue

    for (const row of byReport.get(report.id) ?? []) {
      const key = seriesKey(row.workloadGroupKey, row.registry, row.repository)
      let build = builds.get(key)
      if (!build) {
        build = { source: buildSource(row), live: new Map() }
        builds.set(key, build)
      }

      if (row.changeType === "disappeared") {
        build.live.delete(digestKey(row.digest))
        continue
      }

      build.live.set(digestKey(row.digest), {
        status: row.versionStatus ?? "no_version",
        deployedTag: row.deployedTag,
        latestTag: row.latestTag,
        containerCount: row.containerCount,
      })
    }

    for (const build of builds.values()) {
      const rolled = rollUp(build.live)
      if (!rolled) continue

      build.source.observations.push({
        t,
        status: rolled.status,
        deployedTag: rolled.deployedTag,
        latestTag: rolled.latestTag,
        containerCount: rolled.containerCount,
      })

      for (const [digest, state] of build.live) {
        if (digest === "") continue
        const observations = build.source.byDigest.get(digest)
        const observation: Observation = {
          t,
          status: state.status,
          deployedTag: state.deployedTag,
          latestTag: state.latestTag,
          containerCount: state.containerCount,
        }
        if (observations) observations.push(observation)
        else build.source.byDigest.set(digest, [observation])
      }
    }
  }

  return [...builds.values()].map(build => build.source).filter(source => source.observations.length > 0)
}

async function load(context: string): Promise<DriftHistoryData> {
  const [reports, changes] = await Promise.all([loadReports(context), loadChanges()])

  const known = new Set(reports.map(report => report.id))
  const covered = changes.filter(row => known.has(row.reportId))
  const reportTimes = new Map(reports.map(report => [report.id, parseBackendDate(report.createdAt)]))

  // Nothing is known before the first change row.
  const horizon = covered.reduce<number | null>((earliest, row) => {
    const t = reportTimes.get(row.reportId)
    if (t === undefined) return earliest
    return earliest === null || t < earliest ? t : earliest
  }, null)

  const timeline = reports
    .map(report => parseBackendDate(report.createdAt))
    .filter(t => horizon === null || t >= horizon)
    .sort((a, b) => a - b)

  return {
    timeline,
    reportTimes,
    rottenness: reports
      .filter(report => typeof report.summaryNormalizedScore === "number")
      .map(report => ({
        t: parseBackendDate(report.createdAt),
        score: report.summaryNormalizedScore as number,
        containers: report.summaryTotalContainers ?? 0,
      })),
    sources: replay(covered, reports),
  }
}

const inFlight = new Map<string, Promise<DriftHistoryData>>()

export function loadDriftHistory(context: string): Promise<DriftHistoryData> {
  const hit = inFlight.get(context)
  if (hit) return hit

  const promise = load(context).catch(error => {
    inFlight.delete(context)
    throw error
  })
  inFlight.set(context, promise)
  return promise
}

// A report the fetched list never held means the data predates it.
export function refreshDriftHistory(context: string): Promise<DriftHistoryData> {
  inFlight.delete(context)
  return loadDriftHistory(context)
}
