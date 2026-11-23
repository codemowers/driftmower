"use client"
import Page from "@/app/components/layout/page"

import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import ResourceHeader from "@/app/components/resource-header"
import { ICONS } from "@/app/components/layout/icons"
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
    { label: "Service accounts", href: linkTo("/service-accounts") },
    { label: `Namespace ${namespace}`, href: linkTo(`/namespaces/${encodeURIComponent(namespace)}`) },
    { label: `ServiceAccount ${name}` },
  ]

  return (
    <>
      <Page>
        {state.status !== "ready" && <ResourceHeader icon={ICONS.serviceAccounts} iconAriaLabel="ServiceAccount" title={name} breadcrumbs={breadcrumbs} subtitle={`ServiceAccount in ${namespace}`} />}

        {state.status === "loading" && <LoadingLine loading="effective rights" />}
        {state.status === "error" && <LoadError message={`Failed to evaluate ${namespace}/${name}: ${state.message}`} onRetry={() => reload(false)} />}

        {state.status === "ready" && (
          <>
            <ResourceHeader icon={ICONS.serviceAccounts} iconAriaLabel="ServiceAccount" title={name} breadcrumbs={breadcrumbs}
              subtitle={<span className="font-mono">{state.access.identity.user}</span>}
              actions={<>
                <Button type="button" variant="outline" size="sm" onClick={() => reload(true)}>Re-evaluate</Button>
                <span className="text-xs text-muted-foreground" title={state.access.evaluatedAt}>Evaluated {new Date(state.access.evaluatedAt).toLocaleString()}</span>
              </>} />

            <AccessRights access={state.access} />
          </>
        )}
      </Page>
    </>
  )
}
