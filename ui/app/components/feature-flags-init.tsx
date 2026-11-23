"use client"

import { create } from "zustand"

type FeatureFlags = { workloadRestart: boolean; llm: boolean; oidcUsers: boolean; imageScans: boolean; advisories: boolean }

export const useFeatureFlags = create<FeatureFlags>(() => ({ workloadRestart: false, llm: false, oidcUsers: false, imageScans: false, advisories: false }))
