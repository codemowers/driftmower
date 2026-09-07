import "server-only"

import { kubeApiGetText } from "@/lib/server/k8s"
import type { LogLine } from "../types"
import { compareNs, makeKey, nsToMs, nsToRfc3339, rfc3339ToNs } from "../line"

export function parseKubeLine(raw: string, container: string): LogLine | null {
  const split = raw.indexOf(" ")
  if (split === -1) return null
  const tsNs = rfc3339ToNs(raw.slice(0, split))
  if (tsNs === "0") return null
  const message = raw.slice(split + 1)
  return { tsNs, tsMs: nsToMs(tsNs), container, message, key: makeKey(tsNs, container, message) }
}

export async function fetchKubeContainer(args: {
  ns: string
  pod: string
  container: string
  sinceNs: string | null
  limit: number
}): Promise<LogLine[]> {
  const { ns, pod, container, sinceNs, limit } = args
  const qs = new URLSearchParams({ container, timestamps: "true" })
  if (sinceNs === null) qs.set("tailLines", String(limit))
  else qs.set("sinceTime", nsToRfc3339(sinceNs))
  const path = `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}/log?${qs}`

  let body: string
  try {
    body = await kubeApiGetText(path)
  } catch {
    return []
  }

  const lines: LogLine[] = []
  for (const raw of body.split("\n")) {
    if (!raw) continue
    const parsed = parseKubeLine(raw, container)
    if (parsed) lines.push(parsed)
  }
  return lines
}

export async function fetchKubeAll(args: {
  ns: string
  pod: string
  containers: string[]
  sinceNs: string | null
  limit: number
}): Promise<LogLine[]> {
  const { ns, pod, containers, sinceNs, limit } = args
  const perContainer = await Promise.all(
    containers.map(container => fetchKubeContainer({ ns, pod, container, sinceNs, limit })),
  )
  const lines = perContainer.flat()
  lines.sort((a, b) => compareNs(a.tsNs, b.tsNs))
  return lines
}
