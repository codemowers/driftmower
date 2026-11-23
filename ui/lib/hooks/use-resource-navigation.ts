"use client"

import { useEffect, type ReactNode } from "react"
import { create } from "zustand"

export type ResourceNavigation = {
  parent: string
  href: string
  title: string
  items: { label: string; href: string; meta?: ReactNode; disabled?: boolean }[]
}

export const useResourceNavigationStore = create<{ navigation: ResourceNavigation | null }>(() => ({ navigation: null }))

// The mounted resource owns these sidebar entries, including its live log rate.
export function useResourceNavigation(navigation: ResourceNavigation) {
  useEffect(() => {
    useResourceNavigationStore.setState({ navigation })
    return () => {
      if (useResourceNavigationStore.getState().navigation === navigation) {
        useResourceNavigationStore.setState({ navigation: null })
      }
    }
  }, [navigation])
}
