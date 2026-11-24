"use client"

import { TriangleAlert } from "lucide-react"
import { useOIDCUsers } from "@/lib/features/users/groups"
import { addLocalGroupCommand, existingLocalGroups, groupID, membershipSources, removeGroupCommand, userSettingCommand } from "@/lib/features/users/commands"
import type { OIDCUser } from "@/lib/features/users/types"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import Card from "@/app/components/layout/card"
import CommandSnippet from "@/app/components/command-snippet"
import GroupChip from "@/app/groups/components/group-chip"

export default function UserCommands({ user }: { user: OIDCUser }) {
  const connection = useKubectlConnection()
  const { state: users, retry } = useOIDCUsers()
  const localGroups = existingLocalGroups(users.status === "ready" ? users.users : [user])
  return <Card title="Kubectl commands">
    <p className="text-xs text-muted-foreground">Commands use the configured kubeconfig context. Group edits require jq and preserve other memberships. Repeating a command leaves the same assignment.</p>
    <div className="space-y-4"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Group memberships</h3>
      {user.groups.map(id => {
        const sources = membershipSources(user, id)
        const external = sources.some(source => !source.local) || (!sources.length && id.startsWith("github.com:"))
        const github = sources.some(source => source.source === "github") || id.startsWith("github.com:")
        return <div key={id} className="space-y-2 border-b border-gray-200 pb-4 last:border-b-0"><div className="flex flex-wrap items-center gap-2"><GroupChip id={id} /><span className="text-xs text-muted-foreground">{sources.map(source => `${source.local ? "Local" : source.source} · ${source.source}.groups`).join(", ") || "Membership source not reported"}</span></div>
          {external && <p className="flex items-start gap-2 text-xs text-status-minor-label"><TriangleAlert className="mt-px size-4 shrink-0" aria-label="Warning" /><span>{github ? "On the next GitHub login these memberships are refreshed from GitHub and can return. Remove upstream membership to make the change permanent." : "This membership is refreshed from an external provider at login and can return after removal."}</span></p>}
          <CommandSnippet collapsible={false} fullHeight title="Remove from this group" command={removeGroupCommand(user, id, connection)} />
        </div>
      })}
      {user.groups.length === 0 && <p className="text-sm text-muted-foreground">No effective group memberships.</p>}
    </div>
    <div className="space-y-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sign-in</h3><p className="text-xs text-muted-foreground">Sign-in changes affect future logins; already issued tokens can remain valid until expiry.</p>
      <CommandSnippet collapsible={false} fullHeight title="Disable user sign-in" command={userSettingCommand(user, "type", "banned", connection)} />
      <CommandSnippet collapsible={false} fullHeight title="Enable person sign-in" command={userSettingCommand(user, "type", "person", connection)} />
    </div>
    <div className="space-y-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Local profile and approval</h3>
      <CommandSnippet collapsible={false} fullHeight title="Set local email" command={userSettingCommand(user, "email", "username@example.com", connection)} />
      <p className="text-xs text-muted-foreground">Approval is {user.approved === undefined ? "not set" : String(user.approved)}. Administrative approval bypasses the required-group admission check without granting that group.</p>
      <CommandSnippet collapsible={false} fullHeight title="Approve account" command={userSettingCommand(user, "approved", true, connection)} /><CommandSnippet collapsible={false} fullHeight title="Revoke administrative approval" command={userSettingCommand(user, "approved", false, connection)} />
    </div>
    <div className="space-y-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add to an existing local group</h3>
      {users.status === "loading" && <p className="text-xs text-muted-foreground">Loading local groups from users…</p>}
      {users.status === "error" && <p className="text-xs text-muted-foreground">Local group discovery unavailable: {users.message} <button className="underline" onClick={retry}>Retry</button></p>}
      {localGroups.map(group => <CommandSnippet key={groupID(group)} title={<>Add to group <span className="font-mono">{groupID(group)}</span></>} command={addLocalGroupCommand(user, group, connection)} collapsible={false} fullHeight />)}
      {users.status === "ready" && localGroups.length === 0 && <p className="text-sm text-muted-foreground">No existing local groups were found.</p>}
    </div>
  </Card>
}
