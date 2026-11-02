"use client"

import { useEffect } from "react"
import { create } from "zustand"

type FeatureFlags = { workloadRestart: boolean; llm: boolean }

export const useFeatureFlags = create<FeatureFlags>(() => ({ workloadRestart: false, llm: false }))

export default function FeatureFlagsInit({ workloadRestart, llm }: FeatureFlags) {
  useEffect(() => {
    useFeatureFlags.setState({ workloadRestart, llm })
  }, [workloadRestart, llm])

  return null
}
