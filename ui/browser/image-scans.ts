import { scanFailureMessage } from "@/lib/features/vulnerability/scan-failure"
import { callTool, fetchMcp } from "./connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { findingsReport, type ArtifactFindings, type CycloneDX } from "@/lib/features/vulnerability/cyclonedx"
import type { Report } from "@/lib/cluster/reports"

type Artifact = { filesystemOnly?: boolean; status: string; url?: string; attempts?: number; reason?: string; findings?: ArtifactFindings }
type ImageScan = { containerImage?: string; artifacts: Artifact[] }

function scans(digests: string[], includeFindings: boolean, signal?: AbortSignal): Promise<Record<string, ImageScan>> {
  if (!digests.length) return Promise.resolve({})
  return callTool<{ images: Record<string, ImageScan> }>("get_image_scans", { digests, includeFindings }, signal).then(r => r.images)
}

// The latest failure of an unfinished scan, with the attempts made so far.
function scanFailure(artifacts: Artifact[]): string | undefined {
  const failed = artifacts.find(a => a.reason)
  return failed && `${scanFailureMessage(failed.reason!)}${failed.attempts ? ` (attempt ${failed.attempts})` : ""}`
}

function scanStatus(artifacts: Artifact[]): string {
  if (artifacts.length && artifacts.every(a => a.status === "complete")) return "complete"
  if (artifacts.some(a => a.status === "failed")) return "failed"
  if (artifacts.some(a => a.findings)) return "partial"
  if (artifacts.some(a => a.status === "expired")) return "expired"
  if (artifacts.some(a => a.status === "unavailable" || a.status === "invalid")) return "unavailable"
  return "pending"
}

// Loads the vulnerability findings of every selected image in one tool call.
// Full SBOMs are never downloaded here.
export async function loadImageScans(usages: Report["report"]["imageUsages"], cancelled: () => boolean, signal?: AbortSignal) {
  const digests = [...new Set(usages.filter(u => !u.finished).map(u => u.imageInfo.digest).filter(d => /^sha256:[a-f0-9]{64}$/.test(d)))]
  useClusterState.setState(state => ({ vulnerabilityReportsError: null, imageScanStatuses: { ...state.imageScanStatuses, ...Object.fromEntries(digests.filter(d => !state.imageScanStatuses[d]).map(d => [d, "loading"])) } }))
  const found = await scans(digests, true, signal)
  if (cancelled()) return
  for (const usage of usages) {
    const scan = found[usage.imageInfo.digest]
    if (scan?.containerImage) usage.imageInfo.containerImage = scan.containerImage
  }
  const statuses: Record<string, string> = {}
  const failures: Record<string, string | undefined> = {}
  const reports: Record<string, ReturnType<typeof findingsReport>> = {}
  for (const digest of digests) {
    const artifacts = found[digest]?.artifacts ?? []
    statuses[digest] = found[digest] ? scanStatus(artifacts) : "unavailable"
    failures[digest] = scanFailure(artifacts)
    const ready = artifacts.flatMap(a => a.findings ? [a.findings] : [])
    if (ready.length) reports[digest] = findingsReport(ready, digest)
  }
  useClusterState.setState(state => {
    const retained = { ...state.vulnerabilityReports }
    for (const digest of digests) delete retained[digest]
    return { imageScanStatuses: { ...state.imageScanStatuses, ...statuses }, imageScanFailures: { ...state.imageScanFailures, ...failures }, vulnerabilityReports: { ...retained, ...reports } }
  })
}

// The full CycloneDX documents of one digest, one per scanned platform.
export async function loadSbom(digest: string): Promise<CycloneDX[]> {
  const scan = (await scans([digest], false))[digest]
  if (!scan) throw new Error("No scan is recorded for this image")
  const boms: CycloneDX[] = []
  for (const artifact of scan.artifacts) {
    if (artifact.status !== "available" && !artifact.filesystemOnly) continue
    if (!artifact.url?.startsWith("/api/image-scans/sbom?")) throw new Error("Scanner returned an invalid artifact URL")
    const response = await fetchMcp(artifact.url, { cache: "no-cache" })
    if (!response.ok) continue
    const bom = await response.json() as CycloneDX
    if (bom.bomFormat === "CycloneDX") boms.push(bom)
  }
  if (!boms.length) throw new Error("No CycloneDX artifact is cached for this image")
  return boms
}

// Saves the CycloneDX SBOMs of one image digest as a JSON file: one document,
// or an array of them for an index with several scanned platforms.
export async function downloadSbom(digest: string): Promise<void> {
  const boms = await loadSbom(digest)
  const blob = new Blob([JSON.stringify(boms.length === 1 ? boms[0] : boms, null, 2)], { type: "application/vnd.cyclonedx+json" })
  const link = document.createElement("a")
  link.href = URL.createObjectURL(blob)
  link.download = `${digest.replace(":", "-")}.cdx.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}
