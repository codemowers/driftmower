import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import type { PodEvent } from "./types"

export const POD_EVENTS_MAX = 15

type RawEvent = {
  type?: string
  reason?: string
  count?: number
  firstTimestamp?: string | null
  lastTimestamp?: string | null
  eventTime?: string | null
  message?: string
}

type EventList = { items: RawEvent[] }

export async function getPodEvents(namespace: string, uid: string): Promise<PodEvent[]> {
  const qs = new URLSearchParams({ fieldSelector: `involvedObject.uid=${uid}` })
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/events?${qs}`
  const items = (await kubeApiGet<EventList>(path)).items ?? []
  return dedupeEvents(items.map(toPodEvent))
    .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
    .slice(0, POD_EVENTS_MAX)
}

function toPodEvent(raw: RawEvent): PodEvent {
  return {
    type: raw.type ?? "Normal",
    reason: raw.reason ?? "",
    count: raw.count ?? 1,
    firstSeen: raw.firstTimestamp ?? raw.eventTime ?? null,
    lastSeen: raw.lastTimestamp ?? raw.eventTime ?? null,
    message: raw.message ?? "",
  }
}

export function dedupeEvents(events: PodEvent[]): PodEvent[] {
  const byKey = new Map<string, PodEvent>()
  for (const event of events) {
    const key = `${event.reason}|${event.message}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, event)
      continue
    }
    byKey.set(key, {
      ...existing,
      count: Math.max(existing.count, event.count),
      firstSeen: earliest(existing.firstSeen, event.firstSeen),
      lastSeen: latest(existing.lastSeen, event.lastSeen),
    })
  }
  return [...byKey.values()]
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}
