import { kubectlCommand, type KubeconfigConnection } from "../../kubernetes/contexts.ts"
import { shellQuote } from "../../utils/shell.ts"
import type { OIDCUser, GroupMembership } from "./types.ts"

export type LocalGroup = { prefix: string; name: string }
export function groupID(group: LocalGroup): string { return group.prefix ? `${group.prefix}:${group.name}` : group.name }

export function existingLocalGroups(users: OIDCUser[]): LocalGroup[] {
  const groups = new Map<string, LocalGroup>()
  for (const user of users) for (const membership of user.memberships ?? []) {
    if (membership.local) groups.set(groupID(membership), { prefix: membership.prefix, name: membership.name })
  }
  return [...groups.values()].sort((a, b) => groupID(a).localeCompare(groupID(b)))
}

export function membershipSources(user: OIDCUser, id: string): GroupMembership[] {
  return user.memberships?.filter(group => groupID(group) === id) ?? []
}

// Group arrays use a live read so unrelated memberships survive the edit.
function groupPatch(user: OIDCUser, expression: string, args: string[], connection?: KubeconfigConnection): string {
  const resource = `oidcuser.codemowers.cloud ${shellQuote(user.name)}`
  return `${kubectlCommand("get", connection, user.namespace)} ${resource} -o json |\n  jq -c ${args.join(" ")} ${shellQuote(expression)} |\n  ${kubectlCommand("patch", connection, user.namespace)} ${resource} --type=merge --patch-file=/dev/stdin`
}

export function removeGroupCommand(user: OIDCUser, id: string, connection?: KubeconfigConnection): string {
  const sources = [...new Set(membershipSources(user, id).map(group => group.source))]
  if (!sources.length) return "# Membership source unavailable; refresh user details."
  const fields = sources.map(source => `${JSON.stringify(source)}: {groups: [.${JSON.stringify(source)}.groups[]? | select(([.prefix, .name] | map(select(. != null and . != "")) | join(":")) != $group)]}`)
  return groupPatch(user, `{${fields.join(", ")}}`, [`--arg group ${shellQuote(id)}`], connection)
}

export function addLocalGroupCommand(user: OIDCUser, group: LocalGroup, connection?: KubeconfigConnection): string {
  return groupPatch(user, '{spec: {groups: (((.spec.groups // []) + [$group]) | unique_by([.prefix // "", .name]))}}', [`--argjson group ${shellQuote(JSON.stringify(group))}`], connection)
}

export function userSettingCommand(user: OIDCUser, setting: "type" | "email" | "companyEmail" | "displayName" | "approved", value: string | boolean, connection?: KubeconfigConnection): string {
  const patch = setting === "displayName" || setting === "approved"
    ? { passmower: { [setting === "displayName" ? "name" : "approved"]: value } }
    : { spec: { [setting]: value } }
  return `${kubectlCommand("patch", connection, user.namespace)} oidcuser.codemowers.cloud ${shellQuote(user.name)} --type=merge -p ${shellQuote(JSON.stringify(patch))}`
}
