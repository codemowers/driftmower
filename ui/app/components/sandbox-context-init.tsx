"use client"

import { useEffect } from "react"
import { useSearchParams } from "next/navigation"
import {
  hydrateSandboxContext,
  readSandboxParam,
  syncSandboxParam,
  useSandboxContext,
} from "@/lib/tenancy/sandbox-context"

// Bridges the ?sandbox= URL contract and the sandbox-context store:
// - hydrates the sandbox list once per session,
// - lets ?sandbox=<id> (platform-manager deep links) drive the selection,
// - re-mirrors the in-store selection after navigations that dropped the param.
export default function SandboxContextInit() {
  const searchParams = useSearchParams()
  // Reads the pre-rename ?tenant= key too, so old links stay scoped.
  const sandboxParam = readSandboxParam(new URLSearchParams(searchParams.toString()))
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
        state.selectedSandboxes.every((s, i) => s === fromUrl[i])
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

    // First load without a deep link: no selection, which scopes a non-admin to
    // all their sandboxes.
    if (!hydrated) return
    useSandboxContext.setState({ initialized: true })
  }, [sandboxParam, hydrated])

  return null
}
