import { kubeApiGet } from "@/lib/api/k8s"
import type { LogLine, LogsResponse, LogSource } from "./types"
import { TAIL_LINES } from "./constants"
import { fetchLokiLines, resolveLokiUrl } from "./sources/loki"
import { fetchKubeAll, fetchKubeContainer } from "./sources/kube"

type PodSpecResponse = {
  spec?: {
    containers?: { name: string }[]
    initContainers?: { name: string }[]
  }
}

export async function listContainers(ns: string, pod: string): Promise<string[]> {
  const data = await kubeApiGet<PodSpecResponse>(
    `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}`,
  )
  const main = data.spec?.containers?.map(c => c.name) ?? []
  const init = data.spec?.initContainers?.map(c => c.name) ?? []
  return [...main, ...init]
}

export async function getPodLogs(args: {
  ns: string
  pod: string
  uid: string
  container?: string
  sinceNs: string | null
  limit?: number
  source?: LogSource | null
}): Promise<LogsResponse> {
  const { ns, pod, uid, container, sinceNs } = args
  const limit = args.limit ?? TAIL_LINES

  async function fetchKube(): Promise<LogLine[]> {
    const containers = container ? [container] : await listContainers(ns, pod)
    return container
      ? fetchKubeContainer({ ns, pod, container, sinceNs, limit })
      : fetchKubeAll({ ns, pod, containers, sinceNs, limit })
  }

  if (args.source !== "kube API") {
    const lokiUrl = resolveLokiUrl()
    if (lokiUrl) {
      const lokiLines = await fetchLokiLines({ url: lokiUrl, uid, container, sinceNs, limit })
      if (lokiLines !== null) {
        if (lokiLines.length > 0 || sinceNs !== null) return { source: "loki", lines: lokiLines }
        const kubeLines = await fetchKube()
        if (kubeLines.length > 0) return { source: "kube API", lines: kubeLines }
        return { source: "loki", lines: [] }
      }
    }
  }

  return { source: "kube API", lines: await fetchKube() }
}
