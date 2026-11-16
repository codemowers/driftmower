"use client"
import { create } from "zustand"
import type { KubeconfigConnection } from "./contexts"

export const useKubeconfigState = create<{
  connections: KubeconfigConnection[]
  endpoint: string
  selectedKey?: string
  defaultContext?: string
}>(() => ({ connections: [], endpoint: "" }))
