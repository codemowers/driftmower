"use client"

import { useState } from "react"
import { TriangleAlert } from "lucide-react"
import { useOIDCUsers } from "@/lib/features/users/groups"
import { addLocalGroupCommand, existingLocalGroups, groupID, membershipSources, removeGroupCommand, userSettingCommand } from "@/lib/features/users/commands"
import type { OIDCUser } from "@/lib/features/users/types"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import CommandSnippet from "@/app/components/command-snippet"
import GroupChip from "@/app/groups/components/group-chip"

export default function UserCommands({ user }: { user: OIDCUser }) {
  const connection = useKubectlConnection()
  const { state: users, retry } = useOIDCUsers()
  const localGroups = existingLocalGroups(users.status === "ready" ? users.users : [user])
  const [selectedGroup, setSelectedGroup] = useState("")
  const selected = localGroups.find(group => groupID(group) === selectedGroup) ?? localGroups[0]
  const [type, setType] = useState(user.type || "person")
  const [displayName, setDisplayName] = useState(user.localDisplayName || user.displayName || "")
  const [email, setEmail] = useState(user.localEmail || "")
  const [companyEmail, setCompanyEmail] = useState(user.companyEmail || "")
  return <section className="space-y-6 rounded-xl border border-gray-200 bg-white p-5">
    <div><h2 className="text-lg font-semibold">Manage user with kubectl</h2><p className="mt-1 text-xs text-muted-foreground">Commands use the configured kubeconfig context. Group edits require jq and preserve other memberships. Repeating a command leaves the same assignment.</p></div>
    <div className="space-y-4"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Group memberships</h3>
      {user.groups.map(id => {
        const sources = membershipSources(user, id)
        const external = sources.some(source => !source.local) || (!sources.length && id.startsWith("github.com:"))
        const github = sources.some(source => source.source === "github") || id.startsWith("github.com:")
        return <div key={id} className="space-y-2 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-2"><GroupChip id={id} /><span className="text-xs text-muted-foreground">{sources.map(source => `${source.local ? "Local" : source.source} · ${source.source}.groups`).join(", ") || "Membership source not reported"}</span></div>
          {external && <p className="flex items-start gap-2 text-xs text-status-minor-label"><TriangleAlert className="mt-px size-4 shrink-0" aria-label="Warning" /><span>{github ? "On the next GitHub login these memberships are refreshed from GitHub and can return. Remove upstream membership to make the change permanent." : "This membership is refreshed from an external provider at login and can return after removal."}</span></p>}
          <CommandSnippet title="Remove from this group" command={removeGroupCommand(user, id, connection)} />
        </div>
      })}
      {user.groups.length === 0 && <p className="text-sm text-muted-foreground">No effective group memberships.</p>}
    </div>
    <div className="space-y-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add to an existing local group</h3>
      {users.status === "loading" && <p className="text-xs text-muted-foreground">Loading local groups from users…</p>}
      {users.status === "error" && <p className="text-xs text-muted-foreground">Local group discovery unavailable: {users.message} <button className="underline" onClick={retry}>Retry</button></p>}
      {selected ? <><select aria-label="Existing local group" value={groupID(selected)} onChange={event => setSelectedGroup(event.target.value)} className="max-w-full rounded border px-3 py-2 text-sm">{localGroups.map(group => <option key={groupID(group)} value={groupID(group)}>{groupID(group)}</option>)}</select><CommandSnippet title={`Add ${user.name} to ${groupID(selected)}`} command={addLocalGroupCommand(user, selected, connection)} open /></> : users.status === "ready" && <p className="text-sm text-muted-foreground">No existing local groups were found.</p>}
    </div>
    <div className="space-y-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sign-in and account type</h3><p className="text-xs text-muted-foreground">Current type: {user.type || "person"}. Sign-in changes affect future logins; already issued tokens can remain valid until expiry.</p>
      <CommandSnippet title="Disable user sign-in" command={userSettingCommand(user, "type", "banned", connection)} />
      <CommandSnippet title="Enable person sign-in" command={userSettingCommand(user, "type", "person", connection)} />
      <label className="flex flex-wrap items-center gap-3 text-sm">Account type<select value={type} onChange={event => setType(event.target.value)} className="rounded border px-3 py-2">{["person", "service", "org", "group", "banned"].map(value => <option key={value}>{value}</option>)}</select></label>
      <p className="text-xs text-muted-foreground">Service accounts sign in only through admin impersonation. Organization, group and banned accounts cannot sign in.</p>
      <CommandSnippet title={`Set account type to ${type}`} command={userSettingCommand(user, "type", type, connection)} />
    </div>
    <details className="space-y-3"><summary className="cursor-pointer text-sm font-semibold">Local profile and approval</summary>
      <label className="block text-sm">Local display name<input value={displayName} onChange={event => setDisplayName(event.target.value)} className="mt-1 block w-full rounded border px-3 py-2" /></label><CommandSnippet title="Set local display name" command={userSettingCommand(user, "displayName", displayName, connection)} />
      <label className="block text-sm">Local email<input type="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 block w-full rounded border px-3 py-2" /></label><CommandSnippet title="Set local email" command={userSettingCommand(user, "email", email, connection)} />
      <label className="block text-sm">Company email<input type="email" value={companyEmail} onChange={event => setCompanyEmail(event.target.value)} className="mt-1 block w-full rounded border px-3 py-2" /></label><CommandSnippet title="Set company email" command={userSettingCommand(user, "companyEmail", companyEmail, connection)} />
      <p className="text-xs text-muted-foreground">Approval is {user.approved === undefined ? "not set" : String(user.approved)}. Administrative approval bypasses the required-group admission check without granting that group.</p>
      <CommandSnippet title="Approve account" command={userSettingCommand(user, "approved", true, connection)} /><CommandSnippet title="Revoke administrative approval" command={userSettingCommand(user, "approved", false, connection)} />
    </details>
  </section>
}
