"use client"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Breadcrumbs from "../../components/breadcrumbs"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import { Button } from "@/components/ui/button"
import { callTool } from "@/browser/connection"
import { useContextHref } from "@/lib/hooks/use-context-href"
import GroupChip from "@/app/groups/components/group-chip"
import { formatSignIn, type UserAccess, userAccessError } from "@/lib/features/users/types"
import AccessRights from "../components/access-rights"
import UserCommands from "../components/user-commands"

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; access: UserAccess }

export default function UserDetailPage() {
  const params = useParams<{ name: string }>()
  const name = decodeURIComponent(params.name)
  const { linkTo } = useContextHref()
  const [state, setState] = useState<State>({ status: "loading" })
  const [request, setRequest] = useState({ attempt: 0, refresh: false })

  useEffect(() => {
    let cancelled = false
    callTool<UserAccess>("get_oidc_user_access", { name, refresh: request.refresh })
      .then(access => { if (!cancelled) setState({ status: "ready", access }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: userAccessError(e) }) })
    return () => { cancelled = true }
  }, [name, request])
  const reload = (refresh: boolean) => { setState({ status: "loading" }); setRequest(r => ({ attempt: r.attempt + 1, refresh })) }

  const breadcrumbs = [{ label: "Users", href: linkTo("/users") }, { label: name }]

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <Breadcrumbs items={breadcrumbs} />

        {state.status === "loading" && <LoadingLine loading="effective rights" />}
        {state.status === "error" && <LoadError message={`Failed to evaluate ${name}: ${state.message}`} onRetry={() => reload(false)} />}

        {state.status === "ready" && (() => {
          const a = state.access
          return (
            <>
              <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <h1 className="text-2xl font-semibold">{a.user.displayName || a.user.name}</h1>
                  <p className="text-sm text-muted-foreground">
                    {a.user.name}{a.user.primaryEmail && <> · {a.user.primaryEmail}</>} · last sign-in {formatSignIn(a.user.lastSignIn).toLowerCase()}
                  </p>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {a.user.groups.map(g => <GroupChip key={g} id={g} />)}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Button type="button" variant="outline" size="sm" onClick={() => reload(true)}>Re-evaluate</Button>
                  <span className="text-xs text-muted-foreground" title={a.evaluatedAt}>Evaluated {new Date(a.evaluatedAt).toLocaleString()}</span>
                </div>
              </header>

              <AccessRights access={a} />
              <UserCommands key={a.user.name + a.evaluatedAt} user={a.user} />
            </>
          )
        })()}
      </main>
    </div>
  )
}
