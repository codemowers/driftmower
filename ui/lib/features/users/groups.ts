"use client"

import { useEffect, useState } from "react"
import { callTool } from "@/browser/connection"
import { type OIDCUser, type ServiceAccount, userAccessError } from "./types"

export { groupsFromUsers, parseGroup, type GroupInfo } from "./group-info"

export type UsersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; users: OIDCUser[] }

export function useOIDCUsers(): { state: UsersState; retry: () => void } {
  const [state, setState] = useState<UsersState>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    callTool<{ users: OIDCUser[] }>("list_oidc_users")
      .then(r => { if (!cancelled) setState({ status: "ready", users: [...r.users].sort((a, b) => a.name.localeCompare(b.name)) }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: userAccessError(e) }) })
    return () => { cancelled = true }
  }, [attempt])
  return { state, retry: () => { setState({ status: "loading" }); setAttempt(a => a + 1) } }
}

export type ServiceAccountsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; serviceAccounts: ServiceAccount[] }

export function useServiceAccounts(): { state: ServiceAccountsState; retry: () => void } {
  const [state, setState] = useState<ServiceAccountsState>({ status: "loading" })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    callTool<{ serviceAccounts: ServiceAccount[] }>("list_service_accounts")
      .then(r => { if (!cancelled) setState({ status: "ready", serviceAccounts: r.serviceAccounts }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: userAccessError(e) }) })
    return () => { cancelled = true }
  }, [attempt])
  return { state, retry: () => { setState({ status: "loading" }); setAttempt(a => a + 1) } }
}
