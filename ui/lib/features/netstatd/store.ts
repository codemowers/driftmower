import { create } from "zustand"
import type { NetstatdState } from "./types"

const initial = (): NetstatdState => ({
  status: "idle",
  error: null,
  lastFlushedAt: null,
  aggregates: new Map(),
  listening: new Map(),
  hosts: new Map(),
  hiddenCount: 0,
  upstream: null,
})

export const useNetstatd = create<NetstatdState>(initial)

export const useNetstatdMissing = () => useNetstatd(s => s.upstream?.total === 0)
