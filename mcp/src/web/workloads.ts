const dependencies = [
  'pods',
  'images',
  'configmaps',
  'secrets',
  'certificates',
  'pvcs',
  'services',
  'ingresses'
] as const

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function qualifiedKind(workload: Record<string, unknown>): string {
  const kind = String(workload.kind ?? 'Unknown')
  const apiVersion = String(workload.apiVersion ?? '')
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0] : ''

  return kind + (group ? '.' + group : '')
}

export function workloadOwnerId(workload: Record<string, unknown>): string {
  return JSON.stringify([
    workload.namespace,
    workload.apiVersion,
    workload.kind,
    workload.uid ?? workload.name
  ])
}

// JSON double-quoted strings are valid YAML scalars. All values remain text,
// including owner names and API groups received from the cluster.
export function workloadYaml(
  workloads: Record<string, unknown>[],
  filter: string
): { owners: { id: string; label: string; text: string }[]; shown: number } {
  const query = filter.trim().toLowerCase()
  const visible = workloads.filter(
    workload =>
      !query ||
      JSON.stringify(workload).toLowerCase().includes(query) ||
      qualifiedKind(workload).toLowerCase().includes(query)
  )
  const owners = visible.map(workload => {
    const kind = qualifiedKind(workload)
    const namespaceBucket = workload.kind === 'Namespace'
    const lines: string[] = []
    const prefix = namespaceBucket ? '  ' : '    '

    if (namespaceBucket) lines.push('orphaned:')
    else lines.push(`${JSON.stringify(kind)}:`, `  ${JSON.stringify(workload.name ?? 'Unnamed')}:`)

    const grouped = object(workload.orphaned)
    const groupedNames = new Map<string, Set<string>>()

    for (const entries of Object.values(grouped))
      for (const entry of Object.values(object(entries)))
        for (const category of dependencies) {
          const values = object(entry)[category]

          if (!Array.isArray(values)) continue

          const names = groupedNames.get(category) ?? new Set<string>()

          for (const value of values) if (typeof value === 'string') names.add(value)
          groupedNames.set(category, names)
        }

    function details(value: Record<string, unknown>, indent: string, omitGrouped = false): void {
      for (const field of ['uid', 'ownerReferenceOnly']) {
        const scalar = value[field]

        if (typeof scalar === 'string' || typeof scalar === 'boolean')
          lines.push(`${indent}${field}: ${JSON.stringify(scalar)}`)
      }

      for (const category of dependencies) {
        const values = Array.isArray(value[category])
          ? value[category].filter(
              (item): item is string =>
                typeof item === 'string' && (!omitGrouped || !groupedNames.get(category)?.has(item))
            )
          : []

        if (!values.length) continue

        lines.push(`${indent}${category}:`)
        for (const item of values) lines.push(`${indent}  - ${JSON.stringify(item)}`)
      }
    }

    if (!namespaceBucket) details(workload, prefix)
    else {
      for (const ownerKind of Object.keys(grouped).sort()) {
        lines.push(`  ${JSON.stringify(ownerKind)}:`)
        for (const name of Object.keys(object(grouped[ownerKind])).sort()) {
          lines.push(`    ${JSON.stringify(name)}:`)
          details(object(object(grouped[ownerKind])[name]), '      ')
        }
      }

      // Unowned resources have no generating owner to group under.
      details(Object.fromEntries(dependencies.map(category => [category, workload[category]])), prefix, true)
    }

    return {
      id: workloadOwnerId(workload),
      label: `${kind} / ${String(workload.name ?? 'Unnamed')} · ${String(workload.namespace ?? '')}`,
      text: lines.join('\n') + '\n'
    }
  })

  return { owners, shown: owners.length }
}
