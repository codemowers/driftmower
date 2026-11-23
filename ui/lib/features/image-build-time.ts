// These are distinct observed facts. File time is an estimate, not a declared
// build date: builds may preserve or normalize timestamps from their inputs.
export type ImageTimeFact = {
  source: "label" | "config" | "file"
  timestamp: string
  digest?: string
}

type ArtifactTimes = { digest: string; configCreated?: string; analysis?: { latestFileModifiedAt?: string } }

export function imageBuildTime(createdLabel: string | undefined, artifacts: ArtifactTimes[] = []) {
  const facts: ImageTimeFact[] = []
  const valid = (timestamp: string | undefined): timestamp is string => Boolean(timestamp && Number.isFinite(Date.parse(timestamp)))
  if (valid(createdLabel)) facts.push({ source: "label", timestamp: createdLabel })
  for (const source of ["config", "file"] as const) {
    const candidates: ImageTimeFact[] = []
    for (const artifact of artifacts) {
      const timestamp = source === "config" ? artifact.configCreated : artifact.analysis?.latestFileModifiedAt
      if (valid(timestamp)) candidates.push({ source, timestamp, ...(artifacts.length > 1 ? { digest: artifact.digest } : {}) })
    }
    candidates.sort((a, b) => (source === "config" ? 1 : -1) * (Date.parse(a.timestamp) - Date.parse(b.timestamp)) || (a.digest ?? "").localeCompare(b.digest ?? ""))
    facts.push(...candidates)
  }
  const times = facts.map(f => Date.parse(f.timestamp))
  return { primary: facts.at(0), facts, conflict: times.length > 1 && Math.max(...times) - Math.min(...times) >= 60 * 60 * 1000 }
}

export const IMAGE_TIME_SOURCES: Record<ImageTimeFact["source"], string> = {
  label: "Created label",
  config: "Config JSON",
  file: "Latest file modification (estimate)",
}
