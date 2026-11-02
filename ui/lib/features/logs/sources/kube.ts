import "server-only"

import { KubeApiError, kubeApiGetText } from "@/lib/server/k8s"
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

export type KubeLogs = { lines: LogLine[]; failures: string[] }

function failureOf(container: string, e: unknown): string {
  const reason = e instanceof KubeApiError ? e.kubeMessage : e instanceof Error ? e.message : String(e)
  return `${container}: ${reason}`
}

export async function fetchKubeContainer(args: {
  ns: string
  pod: string
  container: string
  sinceNs: string | null
  limit: number
  previous: boolean
}): Promise<KubeLogs> {
  const { ns, pod, container, sinceNs, limit, previous } = args
  const qs = new URLSearchParams({ container, timestamps: "true" })
  if (previous) qs.set("previous", "true")
  if (previous || sinceNs === null) qs.set("tailLines", String(limit))
  else qs.set("sinceTime", nsToRfc3339(sinceNs))
  const path = `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}/log?${qs}`

  let body: string
  try {
    body = await kubeApiGetText(path)
  } catch (e) {
    if (previous) throw e
    return { lines: [], failures: [failureOf(container, e)] }
  }

  const lines: LogLine[] = []
  for (const raw of body.split("\n")) {
    if (!raw) continue
    const parsed = parseKubeLine(raw, container)
    if (parsed) lines.push(parsed)
  }
  return { lines, failures: [] }
}

export async function fetchKubeAll(args: {
  ns: string
  pod: string
  containers: string[]
  sinceNs: string | null
  limit: number
  previous: boolean
}): Promise<KubeLogs> {
  const { ns, pod, containers, sinceNs, limit, previous } = args
  const perContainer = await Promise.all(
    containers.map(container => fetchKubeContainer({ ns, pod, container, sinceNs, limit, previous })),
  )
  const lines = perContainer.flatMap(result => result.lines)
  lines.sort((a, b) => compareNs(a.tsNs, b.tsNs))
  return { lines, failures: perContainer.flatMap(result => result.failures) }
}
