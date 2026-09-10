// PURE. What the cluster's API serves, parsed from either discovery shape.
// Deliberately free of "server-only" and of @/ aliases so `node --test
// --experimental-strip-types` can exercise it against captured fixtures.

export type ServedResource = {
  group: string
  version: string
  kind: string
  plural: string
  namespaced: boolean
}

export type ApiSurface = {
  // "<group>/<version>/<kind>" -> the resource, for O(1) recipe lookups.
  byKind: Map<string, ServedResource>
  // "<group>" -> served versions, in the order the apiserver reported them.
  versionsByGroup: Map<string, string[]>
  aggregated: boolean
}

export type AggregatedList = {
  items?: {
    metadata?: { name?: string }
    versions?: {
      version?: string
      resources?: {
        resource?: string
        responseKind?: { kind?: string }
        scope?: string
      }[]
    }[]
  }[]
}

export type GroupList = {
  groups?: { name?: string; versions?: { version?: string }[] }[]
}

export type ResourceList = {
  resources?: { name?: string; kind?: string; namespaced?: boolean }[]
}

export function kindKey(group: string, version: string, kind: string): string {
  return group ? `${group}/${version}/${kind}` : `${version}/${kind}`
}

export function isAggregated(raw: AggregatedList | GroupList): raw is AggregatedList {
  // Content negotiation is advisory: an apiserver that does not understand the
  // `as=` parameter answers with a plain APIGroupList, which has no `items`.
  return Array.isArray((raw as AggregatedList).items)
}

export function fromAggregated(list: AggregatedList): ApiSurface {
  const byKind = new Map<string, ServedResource>()
  const versionsByGroup = new Map<string, string[]>()

  for (const group of list.items ?? []) {
    const groupName = group.metadata?.name ?? ""
    const versions: string[] = []

    for (const version of group.versions ?? []) {
      const versionName = version.version
      if (!versionName) continue
      versions.push(versionName)

      for (const resource of version.resources ?? []) {
        const plural = resource.resource
        const kind = resource.responseKind?.kind
        if (!plural || !kind || plural.includes("/")) continue
        byKind.set(kindKey(groupName, versionName, kind), {
          group: groupName,
          version: versionName,
          kind,
          plural,
          namespaced: resource.scope === "Namespaced",
        })
      }
    }

    if (versions.length > 0) versionsByGroup.set(groupName, versions)
  }

  return { byKind, versionsByGroup, aggregated: true }
}

export function groupVersionsOf(groups: GroupList): { group: string; version: string }[] {
  const pending: { group: string; version: string }[] = []
  for (const group of groups.groups ?? []) {
    const groupName = group.name
    if (!groupName) continue
    for (const version of group.versions ?? []) {
      if (version.version) pending.push({ group: groupName, version: version.version })
    }
  }
  return pending
}

export function fromResourceLists(
  lists: { group: string; version: string; list: ResourceList | null }[],
): ApiSurface {
  const byKind = new Map<string, ServedResource>()
  const versionsByGroup = new Map<string, string[]>()

  for (const { group, version, list } of lists) {
    const seen = versionsByGroup.get(group)
    if (seen) {
      if (!seen.includes(version)) seen.push(version)
    } else {
      versionsByGroup.set(group, [version])
    }

    for (const resource of list?.resources ?? []) {
      const plural = resource.name
      const kind = resource.kind
      // The legacy shape lists subresources as "podmonitors/status". They are
      // never creatable on their own, so they would only pollute the lookup.
      if (!plural || !kind || plural.includes("/")) continue
      byKind.set(kindKey(group, version, kind), {
        group,
        version,
        kind,
        plural,
        namespaced: resource.namespaced === true,
      })
    }
  }

  return { byKind, versionsByGroup, aggregated: false }
}

// Picks the first version the recipe supports that the cluster actually serves.
// Returning null is what lets the planner block with a real explanation instead
// of emitting a manifest the apiserver will reject.
export function negotiateVersion(
  surface: ApiSurface,
  group: string,
  kind: string,
  supported: string[],
): ServedResource | null {
  for (const version of supported) {
    const served = surface.byKind.get(kindKey(group, version, kind))
    if (served) return served
  }
  return null
}

export function servesGroup(surface: ApiSurface, group: string): boolean {
  return surface.versionsByGroup.has(group)
}
