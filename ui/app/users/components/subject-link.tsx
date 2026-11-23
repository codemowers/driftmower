"use client"

import { useFeatureFlags } from "@/app/components/feature-flags-init"
import { useEffect, useState } from "react"
import { Bot, User } from "lucide-react"
import PrefetchLink from "@/app/components/prefetch-link"
import { callTool } from "@/browser/connection"
import { useContextHref } from "@/lib/hooks/use-context-href"
import type { OIDCUser, Subject } from "@/lib/features/users/types"

// Display names by OIDCUser name, shared by every link on a page and
// re-read after a minute. Without list_oidc_users access names stay as they are.
let names: Promise<Map<string, string>> | undefined
function displayNames() {
  if (!names) {
    names = callTool<{ users: OIDCUser[] }>("list_oidc_users")
      .then(r => new Map(r.users.filter(u => u.displayName).map(u => [u.name, u.displayName!])))
      .catch(() => new Map<string, string>())
    void names.finally(() => setTimeout(() => { names = undefined }, 60_000))
  }
  return names
}

function useDisplayName(name?: string) {
  const [display, setDisplay] = useState<string>()
  useEffect(() => {
    if (!name) return
    let cancelled = false
    void displayNames().then(m => { if (!cancelled) setDisplay(m.get(name)) })
    return () => { cancelled = true }
  }, [name])
  return name ? display ?? name : undefined
}

// A person as their full name, a ServiceAccount as namespace/name, each
// behind its icon and linked to its page; any other username as it is.
export default function SubjectLink({ subject, className = "" }: { subject: Subject; className?: string }) {
  const { linkTo } = useContextHref()
  const enabled = useFeatureFlags(s => s.oidcUsers)
  const person = useDisplayName(enabled ? subject.oidcUser : undefined)
  const sa = subject.serviceAccount
  const link = subject.oidcUser
    ? { href: linkTo(`/users/${encodeURIComponent(subject.oidcUser)}`), Icon: User, label: person ?? subject.oidcUser }
    : sa ? { href: linkTo(`/service-accounts/${encodeURIComponent(sa.namespace)}/${encodeURIComponent(sa.name)}`), Icon: Bot, label: `${sa.namespace}/${sa.name}` } : undefined
  if (!link) return <span className={`break-all font-mono ${className}`}>{subject.username}</span>
  return (
    <PrefetchLink href={link.href} title={subject.username} className={`inline-flex items-center gap-1.5 text-brand-text hover:underline ${className}`}>
      <link.Icon className="size-3.5 shrink-0" aria-label={sa ? "ServiceAccount" : "Person"} />
      <span className={sa ? "break-all font-mono" : ""}>{link.label}</span>
    </PrefetchLink>
  )
}
