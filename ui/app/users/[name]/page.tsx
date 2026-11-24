"use client"
import Page from "@/app/components/layout/page"
import DetailLayout from "@/app/components/layout/detail-layout"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import ResourceHeader from "@/app/components/resource-header"
import { ICONS } from "@/app/components/layout/icons"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import { Button } from "@/components/ui/button"
import { callTool } from "@/browser/connection"
import { useContextHref } from "@/lib/hooks/use-context-href"
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
    <>
      <Page>
        {state.status !== "ready" && <ResourceHeader icon={ICONS.users} iconAriaLabel="User" title={name} breadcrumbs={breadcrumbs} subtitle="OIDC user" />}

        {state.status === "loading" && <LoadingLine loading="effective rights" />}
        {state.status === "error" && <LoadError message={`Failed to evaluate ${name}: ${state.message}`} onRetry={() => reload(false)} />}

        {state.status === "ready" && (() => {
          const a = state.access
          return (
            <>
              <ResourceHeader icon={ICONS.users} iconAriaLabel="User" title={a.user.displayName || a.user.name} breadcrumbs={breadcrumbs}
                subtitle={<>{a.user.name}{a.user.primaryEmail && <> · {a.user.primaryEmail}</>} · last sign-in {formatSignIn(a.user.lastSignIn).toLowerCase()}</>}
                actions={<>
                  <Button type="button" variant="outline" size="sm" onClick={() => reload(true)}>Re-evaluate</Button>
                  <span className="text-xs text-muted-foreground" title={a.evaluatedAt}>Evaluated {new Date(a.evaluatedAt).toLocaleString()}</span>
                </>} />
              <DetailLayout equalColumns main={<AccessRights access={a} />} aside={<UserCommands key={a.user.name + a.evaluatedAt} user={a.user} />} />
            </>
          )
        })()}
      </Page>
    </>
  )
}
