"use client"

import { useEffect } from "react"
import { create } from "zustand"

export const useWorkloadRestart = create<{ enabled: boolean }>(() => ({ enabled: false }))

export default function WorkloadRestartInit({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    useWorkloadRestart.setState({ enabled })
  }, [enabled])

  return null
}
