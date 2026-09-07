"use client"

import { useEffect, useState } from "react"
import { useNetstatd } from "./store"

const STABILIZE_MS = 4_000
const MIN_OBSERVE_MS = 4_000
const HARD_CAP_MS = 35_000

type Tracking = { seen: Set<string>; startedAt: number; lastGrowthAt: number }
const trackers = new Map<string, Tracking>()

export function resetNetstatdStable(workloadUid: string): void {
  trackers.delete(workloadUid)
}

function evaluate(workloadUid: string, now: number): boolean {
  let t = trackers.get(workloadUid)
  if (!t) {
    t = { seen: new Set(), startedAt: now, lastGrowthAt: now }
    trackers.set(workloadUid, t)
  }

  const s = useNetstatd.getState()
  for (const b of s.aggregates.values()) {
    if (!t.seen.has(b.peerIP)) {
      t.seen.add(b.peerIP)
      t.lastGrowthAt = now
    }
  }
  for (const p of s.listening.values()) {
    const key = `L:${p.key}`
    if (!t.seen.has(key)) {
      t.seen.add(key)
      t.lastGrowthAt = now
    }
  }

  const elapsed = now - t.startedAt
  if (elapsed > HARD_CAP_MS) return true
  return s.status === "open" && elapsed > MIN_OBSERVE_MS && now - t.lastGrowthAt > STABILIZE_MS
}

export function useNetstatdStable(workloadUid: string): boolean {
  const [stable, setStable] = useState(() => evaluate(workloadUid, Date.now()))
  useEffect(() => {
    const id = setInterval(() => setStable(evaluate(workloadUid, Date.now())), 1_000)
    return () => clearInterval(id)
  }, [workloadUid])
  return stable
}
