import { useCallback } from "react"
import { callTool } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useQuery } from "@/lib/hooks/use-query"

export type ImageAnalysis = {
  observedAt: string; newestFileLimit: number; entriesExamined: number; filesObserved: number
  newestFiles: { path: string; modifiedAt: string; size: number; mimeType: string }[]; newestFilesTruncated: boolean; latestFileModifiedAt?: string; latestFilePath?: string
  directoriesObserved: number; symlinksObserved: number; truncated: boolean
  mimeTypes: Record<string, number>; linkingCounts: Record<string, number>
  shells: { path: string; resolvedPath: string }[]; tools: Record<string, string[]>
  binaries: { path: string; linking: string; architecture?: string; interpreter?: string; needed?: string[]; error?: string }[]
  binariesTruncated?: boolean; errors?: string[]
}
export type ImageAnalysisArtifact = { digest: string; status: string; configCreated?: string; analysis?: ImageAnalysis }
export function useImageAnalysis(digests: string[], includeDetails = false) {
  const cluster = useClusterState(s => s.clusterName)
  const digestKey = JSON.stringify([...new Set(digests.filter(d => /^sha256:[a-f0-9]{64}$/.test(d)))].sort())
  const load = useCallback((signal: AbortSignal) => callTool<{ images: Record<string, ImageAnalysisArtifact[]> }>("get_image_analysis", { digests: JSON.parse(digestKey) as string[], includeDetails }, signal), [digestKey, includeDetails])
  return useQuery({ key: cluster && digestKey !== "[]" ? JSON.stringify([cluster, "image-analysis", digestKey, includeDetails]) : null, load, interval: 30_000 })
}
