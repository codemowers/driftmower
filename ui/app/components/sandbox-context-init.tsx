"use client"

import { useEffect } from "react"
import { useSearchParams } from "next/navigation"
import {
  defaultSandboxSelection,
  hydrateSandboxContext,
  syncSandboxParam,
  useSandboxContext,
} from "@/lib/tenancy/sandbox-context"

// Bridges the ?sandbox= URL contract and the sandbox-context store:
// - hydrates the sandbox list once per session,
// - lets ?sandbox=<id> (platform-manager deep links) drive the selection,
// - applies the default selection when the URL carries no sandbox,
// - re-mirrors the in-store selection after navigations that dropped the param.
export default function SandboxContextInit() {
  const searchParams = useSearchParams()
  // Accepts the pre-rename key too, so old links stay scoped.
  const sandboxParam = searchParams.get("sandbox") ?? searchParams.get("tenant")
  const hydrated = useSandboxContext(s => s.hydrated)

  useEffect(() => {
    hydrateSandboxContext()
  }, [])

  useEffect(() => {
    const state = useSandboxContext.getState()

    const fromUrl = sandboxParam ? sandboxParam.split(",").filter(Boolean) : []

    // The URL is the source of truth whenever it names a sandbox.
    if (fromUrl.length > 0) {
      const unchanged =
        state.selectedSandboxes.length === fromUrl.length &&
        state.selectedSandboxes.every((t, i) => t === fromUrl[i])
      if (!unchanged || !state.initialized) {
        useSandboxContext.setState({ selectedSandboxes: fromUrl, initialized: true })
      }
      return
    }

    // No ?sandbox= in the URL: keep the store selection across navigation and
    // put it back into the URL for reloads/sharing.
    if (state.initialized) {
      if (state.selectedSandboxes.length > 0) syncSandboxParam(state.selectedSandboxes)
      return
    }

    // First load without a deep link: pick the default once sandboxes are known.
    if (!hydrated) return
    const fallback = defaultSandboxSelection(state)
    useSandboxContext.setState({ selectedSandboxes: fallback, initialized: true })
    if (fallback.length > 0) syncSandboxParam(fallback)
  }, [sandboxParam, hydrated])

  return null
}
