"use client"

import { create } from "zustand"

type FeatureFlags = { workloadRestart: boolean; llm: boolean }

export const useFeatureFlags = create<FeatureFlags>(() => ({ workloadRestart: false, llm: false }))
