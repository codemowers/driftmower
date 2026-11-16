"use client"

import { useEffect, useState } from "react"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import { Button } from "@/components/ui/button"
import { callTool, toolNames } from "@/browser/connection"
import type { UserAccess } from "@/lib/features/users/types"
import AccessRights from "./access-rights"

type State =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; access: UserAccess }

// The signed-in caller's own effective rights, for the identity the API
// server sees in their token. Hidden when the MCP server does not offer it.
export default function MyAccess() {
  const [state, setState] = useState<State>({ status: "loading" })
  const [request, setRequest] = useState({ attempt: 0, refresh: false })

  useEffect(() => {
    let cancelled = false
    toolNames()
      .then(tools => {
        if (!tools.has("get_my_access")) return cancelled ? undefined : setState({ status: "unavailable" })
        return callTool<UserAccess>("get_my_access", { refresh: request.refresh })
          .then(access => { if (!cancelled) setState({ status: "ready", access }) })
      })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [request])
  const reload = (refresh: boolean) => { setState({ status: "loading" }); setRequest(r => ({ attempt: r.attempt + 1, refresh })) }

  if (state.status === "unavailable") return null
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-medium">Your access</h2>
      {state.status === "loading" && <LoadingLine loading="effective rights" />}
      {state.status === "error" && <LoadError message={`Failed to evaluate your rights: ${state.message}`} onRetry={() => reload(false)} />}
      {state.status === "ready" && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <p className="break-all font-mono text-sm">{state.access.identity.user}</p>
              <div className="flex flex-wrap gap-1">
                {(state.access.identity.groups ?? []).map(g => <span key={g} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{g}</span>)}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Button type="button" variant="outline" size="sm" onClick={() => reload(true)}>Re-evaluate</Button>
              <span className="text-xs text-muted-foreground" title={state.access.evaluatedAt}>Evaluated {new Date(state.access.evaluatedAt).toLocaleString()}</span>
            </div>
          </header>
          <AccessRights access={state.access} />
        </>
      )}
    </section>
  )
}
