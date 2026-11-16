"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Breadcrumbs from "@/app/components/breadcrumbs"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import { Button } from "@/components/ui/button"
import { callTool } from "@/browser/connection"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { type UserAccess, userAccessError } from "@/lib/features/users/types"
import AccessRights from "@/app/users/components/access-rights"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; access: UserAccess }

export default function ServiceAccountPage() {
  const params = useParams<{ namespace: string; name: string }>()
  const namespace = decodeURIComponent(params.namespace)
  const name = decodeURIComponent(params.name)
  const { linkTo } = useContextHref()
  const [state, setState] = useState<State>({ status: "loading" })
  const [request, setRequest] = useState({ attempt: 0, refresh: false })

  useEffect(() => {
    let cancelled = false
    callTool<UserAccess>("get_service_account_access", { namespace, name, refresh: request.refresh })
      .then(access => { if (!cancelled) setState({ status: "ready", access }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: userAccessError(e) }) })
    return () => { cancelled = true }
  }, [namespace, name, request])
  const reload = (refresh: boolean) => { setState({ status: "loading" }); setRequest(r => ({ attempt: r.attempt + 1, refresh })) }

  const breadcrumbs = [
    { label: "Users", href: linkTo("/users") },
    { label: `Namespace ${namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(namespace)}`) },
    { label: `ServiceAccount ${name}` },
  ]

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <Breadcrumbs items={breadcrumbs} />

        {state.status === "loading" && <LoadingLine loading="effective rights" />}
        {state.status === "error" && <LoadError message={`Failed to evaluate ${namespace}/${name}: ${state.message}`} onRetry={() => reload(false)} />}

        {state.status === "ready" && (
          <>
            <header className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-semibold">{name}</h1>
                <p className="font-mono text-sm text-muted-foreground">{state.access.identity.user}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => reload(true)}>Re-evaluate</Button>
                <span className="text-xs text-muted-foreground" title={state.access.evaluatedAt}>Evaluated {new Date(state.access.evaluatedAt).toLocaleString()}</span>
              </div>
            </header>

            <AccessRights access={state.access} />
          </>
        )}
      </main>
    </div>
  )
}
