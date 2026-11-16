"use client"
import { useKubeconfigState } from "@/lib/kubernetes/context-state"
import { connectionForEndpoint, kubectlCommand } from "@/lib/kubernetes/contexts"

export function useKubectlConnection() {
  const state = useKubeconfigState()
  return connectionForEndpoint(state.connections, state.endpoint, state.selectedKey)
    ?? (state.defaultContext ? { key: "deployment", name: state.defaultContext, status: "configured" } : undefined)
}

export function useKubectl() {
  const connection = useKubectlConnection()
  return (verb: string, namespace?: string | null) => kubectlCommand(verb, connection, namespace)
}
