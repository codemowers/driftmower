import type { OIDCUser } from "./types.ts"

// Passmower issues groups as `<prefix>:<name>`. GitHub-derived groups use the
// prefix `github.com` and a name of `<org>:<team>`.
export type GroupInfo = {
  id: string
  source: string
  name: string
  github?: { org: string; team: string; url: string }
  members: OIDCUser[]
}

export function parseGroup(id: string): Omit<GroupInfo, "members"> {
  const i = id.indexOf(":")
  const source = i > 0 ? id.slice(0, i) : ""
  const name = i > 0 ? id.slice(i + 1) : id
  if (source === "github.com") {
    const [org, team] = name.split(":")
    if (org && team) {
      return { id, source, name, github: { org, team, url: `https://github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}` } }
    }
  }
  return { id, source, name }
}

export function groupsFromUsers(users: OIDCUser[]): GroupInfo[] {
  const groups = new Map<string, GroupInfo>()
  for (const user of users) {
    for (const id of user.groups) {
      const group = groups.get(id) ?? { ...parseGroup(id), members: [] }
      group.members.push(user)
      groups.set(id, group)
    }
  }
  return [...groups.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
}
