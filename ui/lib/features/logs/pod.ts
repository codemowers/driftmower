import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import type { LogsResponse, LogSource } from "./types"
import { TAIL_LINES } from "./constants"
import { fetchLokiLines, resolveLokiUrl } from "./sources/loki"
import { fetchKubeAll, fetchKubeContainer, type KubeLogs } from "./sources/kube"

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

function previousRunNotice(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Kubernetes API \S+ returned \d+: /, "").trim()
}

export async function getPodLogs(args: {
  ns: string
  pod: string
  uid: string
  container?: string
  sinceNs: string | null
  limit?: number
  source?: LogSource | null
  previous?: boolean
}): Promise<LogsResponse> {
  const { ns, pod, uid, container, sinceNs } = args
  const limit = args.limit ?? TAIL_LINES
  const previous = args.previous ?? false

  async function fetchKube(): Promise<KubeLogs> {
    const containers = container ? [container] : await listContainers(ns, pod)
    return container
      ? fetchKubeContainer({ ns, pod, container, sinceNs, limit, previous })
      : fetchKubeAll({ ns, pod, containers, sinceNs, limit, previous })
  }

  function fromKube({ lines, failures }: KubeLogs): LogsResponse {
    if (lines.length === 0 && failures.length > 0) return { source: "kube API", lines, notice: failures.join("; ") }
    return { source: "kube API", lines }
  }

  if (previous) {
    try {
      return { source: "kube API", lines: (await fetchKube()).lines }
    } catch (e) {
      return { source: "kube API", lines: [], notice: previousRunNotice(e) }
    }
  }

  if (args.source !== "kube API") {
    const lokiUrl = resolveLokiUrl()
    if (lokiUrl) {
      const lokiLines = await fetchLokiLines({ url: lokiUrl, uid, container, sinceNs, limit })
      if (lokiLines !== null) {
        if (lokiLines.length > 0 || sinceNs !== null) return { source: "loki", lines: lokiLines }
        const kube = await fetchKube()
        if (kube.lines.length > 0) return { source: "kube API", lines: kube.lines }
        return { source: "loki", lines: [] }
      }
    }
  }

  return fromKube(await fetchKube())
}
