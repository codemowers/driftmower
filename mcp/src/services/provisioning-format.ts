import type { Availability, DegradedRead, NamespaceFact, OfferingCard } from '../domain/provisioning.js'
import type {
  ClusterCapabilities,
  NamespaceReadiness,
  OfferingsListing,
  StorageClassExplanation,
  StorageClassNotFound,
  Unavailable
} from './provisioning-service.js'

// Prose for an agent that is relaying to a beginner.
//
// Rules, from driftmower-ui/provisioning.md: lead with the verdict and a count;
// one short paragraph per thing; name real objects so a sentence is greppable;
// and never let an unreadable fact read as a passing one.

export function formatUnavailable(result: Unavailable): string {
  return [`## Provisioning facts unavailable — ${result.reason.replace(/_/g, ' ')}`, '', result.detail].join(
    '\n'
  )
}

export function formatClusterCapabilities(result: ClusterCapabilities): string {
  const lines: string[] = [
    `## Cluster capabilities — ${result.offeringsReady} of ${result.offeringsTotal} offerings ready, ` +
      `${result.storageClasses.length} storage classes`,
    ''
  ]

  lines.push(
    `Scheduling: ${result.topology.schedulableNodes} schedulable node(s) across ` +
      `${result.topology.zones.length || 'no reported'} zone(s). ` +
      `Network policy engine: ${result.networkPolicyEngine}. ` +
      `Prometheus operator ${result.monitoringOperator ? 'is' : 'is not'} present.`
  )
  lines.push('')

  if (result.storageClasses.length > 0) {
    lines.push('### Storage classes')
    lines.push('')

    for (const storageClass of result.storageClasses) {
      lines.push(
        `- **${storageClass.name}**${storageClass.isDefault ? ' (default)' : ''} — ` +
          `${storageClass.provisioner}, ${storageClass.bindingMode} binding, ` +
          `${storageClass.reclaimPolicy} reclaim, ` +
          `${storageClass.allowExpansion ? 'expandable' : 'not expandable'}. ${storageClass.implies}`
      )
    }

    lines.push('')
  }

  if (result.priorityClasses.length > 0) {
    lines.push('### Priority classes')
    lines.push('')

    for (const priorityClass of result.priorityClasses) {
      lines.push(
        `- **${priorityClass.name}** (${priorityClass.value})` +
          `${priorityClass.isDefault ? ' — default' : ''}: ${priorityClass.meaning}`
      )
    }

    lines.push('')
  }

  lines.push('### Ingress and TLS')
  lines.push('')
  lines.push(
    result.ingress.domainSuffix
      ? `Published hostnames end in \`${result.ingress.domainSuffix}\`` +
          (result.ingress.domainSuffixSource === 'app-base-url'
            ? " — derived from driftmower-ui's own address because the admission guard's configured domain could not be read, so confirm it before relying on it."
            : " (read from the admission guard's own parameters).")
      : 'This cluster publishes no ingress domain, so ask the platform team which hostnames you may use.'
  )

  if (result.ingress.tlsAdvice) {
    lines.push('')
    lines.push(result.ingress.tlsAdvice)
  }

  if (result.admissionPolicies.length > 0) {
    lines.push('')
    lines.push('### Admission policies')
    lines.push('')
    lines.push(
      'These override RBAC: a policy can reject something your role allows, so they decide what you may actually apply.'
    )
    lines.push('')

    for (const policy of result.admissionPolicies) {
      lines.push(
        `- **${policy.name}** — ${policy.enforced ? 'enforced' : 'audit only'} (${policy.enforcement}); ` +
          `guards ${policy.guards.map(guard => `${guard.resource}.${guard.group || 'core'}`).join(', ') || 'nothing listed'}.`
      )
    }
  }

  return [...lines, ...degradedSection(result.degraded)].join('\n')
}

export function formatOfferings(result: OfferingsListing): string {
  const ready = result.offerings.filter(offering => offering.availability.state === 'ready')
  const lines: string[] = [
    `## Offerings — ${ready.length} of ${result.offerings.length} ready on this cluster`,
    ''
  ]

  for (const offering of result.offerings) {
    lines.push(`### ${offering.name} — ${availabilitySummary(offering)}`)
    lines.push('')
    lines.push(offering.what)

    if (offering.goodFor.length > 0) {
      lines.push('')
      lines.push(`Good for: ${offering.goodFor.join(', ')}.`)
    }

    if (offering.availability.state !== 'ready' && offering.needs.length > 0) {
      lines.push('')
      lines.push(`Before it could be used here: ${offering.needs.join('; ')}.`)
    }

    if (offering.resource) {
      lines.push('')
      lines.push(
        `Resource: \`${offering.resource}\`${offering.apiVersion ? ` (${offering.apiVersion})` : ''}. ` +
          `${offering.instanceCount} instance(s) visible to you.`
      )
    }

    lines.push('')
  }

  return [...lines, ...degradedSection(result.degraded)].join('\n')
}

export function formatNamespaceReadiness(result: NamespaceReadiness): string {
  const lines: string[] = [
    `## Namespace readiness — ${result.namespaces.length} of ${result.requested.length} namespace(s) reported`,
    ''
  ]

  if (result.withheld.length > 0) {
    lines.push(
      `No facts were returned for ${result.withheld.map(name => `\`${name}\``).join(', ')}. ` +
        'That normally means the namespace is outside your access rather than that it does not exist.'
    )
    lines.push('')
  }

  for (const fact of result.namespaces) {
    lines.push(`### ${fact.namespace}${fact.sandbox ? ` (sandbox \`${fact.sandbox}\`)` : ''}`)
    lines.push('')
    lines.push(`Permission to create here: **${fact.mayCreate}** — ${fact.mayCreateReason}`)
    lines.push('')
    lines.push(quotaSentence(fact))

    if (fact.limitRange) {
      lines.push('')
      lines.push(
        `A LimitRange applies defaults to containers that set none: ` +
          `${describeAmounts(fact.limitRange.default)} limit, ${describeAmounts(fact.limitRange.defaultRequest)} request. ` +
          'A workload that ships without its own `resources` block inherits these, which is a common cause of OOM kills.'
      )
    }

    lines.push('')
    lines.push(
      `Network: ingress ${fact.network.ingress}, egress ${fact.network.egress}` +
        `${fact.network.ciliumAvailable ? ', Cilium policies available' : ''}.`
    )

    const nameSpecific = fact.network.selectors.filter(selector => selector.labelValue !== null)

    if (nameSpecific.length > 0) {
      lines.push('')
      lines.push(
        'Some policies here select on an **exact instance name**: ' +
          nameSpecific
            .map(
              selector => `\`${selector.policy}\` admits only \`${selector.labelKey}=${selector.labelValue}\``
            )
            .join('; ') +
          '. Name an instance anything else and it gets none of that traffic, with no error that points at the cause.'
      )
    }

    if (fact.podSecurity) {
      lines.push('')
      lines.push(
        `Pod Security Admission enforces **${fact.podSecurity.enforce}**: ${fact.podSecurity.summary}` +
          (fact.podSecurity.requires.length > 0
            ? ` Pods must set ${fact.podSecurity.requires.join(', ')}.`
            : '')
      )
    }

    const hostRule = result.hostRules.find(rule => rule.namespace === fact.namespace)

    if (hostRule) {
      lines.push('')
      lines.push(
        hostRule.exactHost
          ? `Hostnames this namespace may claim: \`${hostRule.exactHost}\`` +
              (hostRule.labelledPattern ? ` or \`${hostRule.labelledPattern}\`` : '') +
              `. ${hostRule.note}`
          : hostRule.note
      )
    }

    lines.push('')
  }

  return [...lines, ...degradedSection(result.degraded)].join('\n')
}

export function formatStorageClassExplanation(result: StorageClassExplanation): string {
  const { storageClass, answers } = result
  const lines: string[] = [
    `## Storage class \`${storageClass.name}\`${storageClass.isDefault ? ' (the cluster default)' : ''}`,
    '',
    storageClass.implies,
    '',
    `- **Local to one machine?** ${answers.nodeLocal ? 'Yes' : 'No'} — provisioner \`${storageClass.provisioner}\`, topology ${storageClass.topology}.`,
    `- **Does a volume pin its pod to a node?** ${answers.pinnedToOneNode ? 'Yes' : 'No'}` +
      (answers.pinnedToOneNode && storageClass.bindingMode === 'Immediate'
        ? ' — and binding is `Immediate`, so the volume is placed *before* the pod is scheduled and the pod has to follow it there.'
        : ` — binding mode is \`${storageClass.bindingMode}\`.`),
    `- **Can it grow later?** ${answers.growable ? 'Yes' : 'No, size it correctly up front'}.`,
    `- **Does the data survive deleting the instance?** ${answers.survivesDeletion ? 'Yes' : 'No'} — reclaim policy \`${storageClass.reclaimPolicy}\`.`,
    `- **Safe for several replicas the operator may move?** ${answers.safeForReplicas ? 'Yes' : 'No'}.`
  ]

  if (answers.nodeLocal) {
    lines.push('')
    lines.push(
      'Because this is node-local storage, "3 replicas" means three copies on up to three machines — ' +
        'it is not the high availability the number suggests if the machine is what fails.'
    )
  }

  return [...lines, ...degradedSection(result.degraded)].join('\n')
}

export function formatStorageClassNotFound(result: StorageClassNotFound): string {
  return [
    `## No storage class named \`${result.requested}\` on this cluster`,
    '',
    result.available.length > 0
      ? `Available: ${result.available.map(name => `\`${name}\``).join(', ')}.`
      : 'This cluster reports no storage classes at all, which usually means the read was refused rather than that none exist.'
  ].join('\n')
}

function availabilitySummary(offering: OfferingCard): string {
  const availability: Availability = offering.availability

  switch (availability.state) {
    case 'ready':
      return `ready${availability.version ? ` (${offering.operator?.name ?? 'operator'} ${availability.version})` : ''}`
    case 'degraded':
      return `degraded: ${availability.reason}`
    case 'crds-only':
      return `not usable: ${availability.reason}`
    case 'not-installed':
      return `not installed on this cluster${offering.operator ? ` (${offering.operator.name} is absent)` : ''}`
  }
}

function quotaSentence(fact: NamespaceFact): string {
  if (!fact.quota) {
    return 'No ResourceQuota applies here, so the namespace has no budget of its own.'
  }

  const headroom = fact.headroom

  if (!headroom) {
    return `ResourceQuota \`${fact.quota.name}\` applies: ${describeAmounts(fact.quota.hard)} allowed.`
  }

  return (
    `ResourceQuota \`${fact.quota.name}\`: ` +
    `${formatMillis(headroom.cpuMillis)} CPU, ${formatBytes(headroom.memoryBytes)} memory, ` +
    `${formatBytes(headroom.storageBytes)} storage and ${headroom.pvcCount ?? 'an unreported number of'} PVC(s) still free.`
  )
}

function describeAmounts(amounts: Partial<Record<string, string>>): string {
  const entries = Object.entries(amounts).filter(([, value]) => value !== undefined)

  if (entries.length === 0) {
    return 'nothing specified'
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(', ')
}

function formatMillis(value: number | null): string {
  return value === null ? 'an unreported amount of' : `${value}m`
}

function formatBytes(value: number | null): string {
  if (value === null) {
    return 'an unreported amount of'
  }

  const gibibytes = value / 1024 ** 3

  return gibibytes >= 1 ? `${gibibytes.toFixed(1)}Gi` : `${Math.round(value / 1024 ** 2)}Mi`
}

// Never silently dropped. A refused read that reads as an empty result is the
// one failure mode this whole layer exists to prevent.
function degradedSection(degraded: DegradedRead[]): string[] {
  if (degraded.length === 0) {
    return []
  }

  return [
    '',
    '### Facts that could not be read',
    '',
    'Treat anything below as unknown rather than absent — these reads failed, they did not come back empty.',
    '',
    ...degraded.map(entry => `- **${entry.source}** (HTTP ${entry.status}): ${entry.message}`)
  ]
}
