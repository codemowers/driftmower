import { VERBS } from '../domain/provisioning/access-facts.js'
import type {
  Availability,
  DegradedRead,
  NamespaceFact,
  OfferingCard,
  RegistryFact
} from '../domain/provisioning/types.js'
import type {
  AccessCheck,
  NamespaceReadiness,
  OfferingsListing,
  ProvisioningPlatform,
  Unavailable
} from './provisioning-service.js'

// Prose for an agent that is relaying to a beginner.
//
// Rules: lead with the verdict and a count; one short paragraph per thing;
// name real objects so a sentence is greppable; and never let an unreadable
// fact read as a passing one.

export function formatUnavailable(result: Unavailable): string {
  return [`## Provisioning facts unavailable — ${result.reason.replace(/_/g, ' ')}`, '', result.detail].join(
    '\n'
  )
}

export function formatProvisioningPlatform(result: ProvisioningPlatform): string {
  const lines: string[] = [
    `## Provisioning platform — ${result.offeringsReady} of ${result.offeringsTotal} offerings ready, ` +
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
          (result.ingress.domainSuffixSource === 'config'
            ? ' (configured on this server rather than read from an admission guard, so it is not verified against any policy).'
            : " (read from the admission guard's own parameters).")
      : 'This cluster publishes no ingress domain, so ask the platform team which hostnames you may use.'
  )

  if (result.ingress.classes.length > 0) {
    lines.push('')
    lines.push(
      `Ingress classes: ${result.ingress.classes.map(c => `\`${c.name}\`${c.isDefault ? ' (default)' : ''}`).join(', ')}.`
    )
  }

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

    if (result.tenantLabelKey) {
      lines.push('')
      lines.push(`Enforced policies scope tenancy on the namespace label \`${result.tenantLabelKey}\`.`)
    }
  }

  if (result.policies.length > 0) {
    lines.push('')
    lines.push('### Kyverno policies')
    lines.push('')

    for (const policy of result.policies) {
      lines.push(
        `- **${policy.name}** — ${policy.mode}; touches ${policy.touches.join(', ') || 'unspecified kinds'}. ${policy.meaning}`
      )
    }
  }

  return [...lines, ...degradedSection(result.degraded)].join('\n')
}

export function formatAccessCheck(
  result: AccessCheck,
  input: { verb: string; group: string; resource: string; namespace?: string }
): string {
  const what = `${input.verb} ${input.resource}.${input.group || 'core'}${input.namespace ? ` in namespace ${input.namespace}` : ' cluster-wide'}`
  const lines = [`## ${what} — ${result.verdict}`, '', result.reason]

  if (result.identity)
    lines.push('', `Asked of the cluster authorizer as Kubernetes user \`${result.identity.user}\`.`)

  return lines.join('\n')
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
        `Resource: \`${offering.resource}\`${offering.apiVersion ? ` (${offering.apiVersion})` : ''}.`
      )
    }

    if (offering.mayCreate) {
      lines.push('')
      lines.push(
        `May you create it there: **${offering.mayCreate}**. ${offering.mayCreateReason ?? ''}`.trim()
      )
    }

    lines.push('')
  }

  if (result.withheld.length > 0) {
    lines.push(
      `No per-namespace verdict for ${result.withheld.map(name => `\`${name}\``).join(', ')}: ` +
        'the cluster authorizer does not let you list pods there, or could not say.'
    )
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
      `No facts were returned for ${result.withheld.map(name => `\`${name}\``).join(', ')}: ` +
        'the cluster authorizer does not let you list pods there, or could not say. That is about your access, not about whether the namespace exists.'
    )
    lines.push('')
  }

  for (const fact of result.namespaces) {
    lines.push(
      `### ${fact.namespace}${fact.tenant ? ` (\`${fact.tenant.labelKey}=${fact.tenant.id}\`)` : ''}`
    )
    lines.push('')
    lines.push(accessSentence(fact))
    lines.push('')
    lines.push(
      `Permission to create the requested offering here: **${fact.mayCreate}** — ${fact.mayCreateReason}`
    )
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
              (hostRule.customDomains.length
                ? `, or any name under ${hostRule.customDomains.map(domain => `\`${domain}\``).join(', ')}`
                : '') +
              `. ${hostRule.note}`
          : hostRule.note
      )
    }

    for (const registry of fact.registries) lines.push('', ...registrySection(registry))

    lines.push('')
  }

  return [...lines, ...degradedSection(result.degraded)].join('\n')
}

function registrySection(registry: RegistryFact): string[] {
  return [
    `Container registry: Zot at \`${registry.host}\` (Ingress \`${registry.ingress}\` → Service \`${registry.service}\` → Deployment \`${registry.deployment}\`)` +
      (registry.tls
        ? '.'
        : ', served without TLS here, so Docker and Skaffold must be told it is an insecure registry.'),
    '',
    'To build with Skaffold, save these lines as `skaffold.env` next to `skaffold.yaml`. Skaffold reads that file on every run, ' +
      'so builds are pushed to this registry and deployed to this namespace through its own kube context, whatever context is current. ' +
      'Keep image names in `skaffold.yaml` bare (`myapp`, not a full reference): Skaffold prefixes them with the default repo. ' +
      'The file is specific to this namespace and cluster, so keep it out of version control. ' +
      'Prefer it over `skaffold config set default-repo`, which writes to global config instead of the project.',
    '',
    '```',
    registry.skaffoldEnv,
    '```',
    '',
    `Pushing needs credentials the registry accepts: run \`docker login ${registry.host}\` first.`
  ]
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

// Never the whole matrix: counts and the derived tiers, plus the per-offering
// verdicts. The full matrix travels in structuredContent for anything that
// wants a specific cell.
function accessSentence(fact: NamespaceFact): string {
  const access = fact.access

  if (!access) {
    return (
      'Access: not checked, because the call carried no verified caller. Run `kubectl auth can-i --list -n ' +
      fact.namespace +
      '` yourself.'
    )
  }

  const { byVerb, resourceTypes, unknown } = access.summary
  const reads = Math.max(byVerb.get, byVerb.list, byVerb.watch)
  // The composed verdict (RBAC across everything the offering creates, then
  // enforced admission), naming what blocks it: the resources RBAC refuses,
  // or the admission policy when RBAC alone would have allowed it.
  const provision = Object.entries(fact.offerings)
    .map(([id, entry]) => {
      if (!entry || entry.verdict === 'yes') return `${id} ${entry?.verdict ?? 'unknown'}`

      const policy = /admission policy \(([^)]+)\)/.exec(entry.reason)?.[1]
      const blocked = (access.provisionDetail[id as keyof typeof access.provisionDetail] ?? []).filter(
        row => row.verdict !== 'yes'
      )
      const why = policy ? `admission policy ${policy}` : blocked.map(row => row.resource).join(', ')

      return `${id} ${entry.verdict}${why ? ` (${why})` : ''}`
    })
    .join(', ')
  const oddities = Object.entries(access.matrix)
    .filter(([, row]) => row.create === 'yes' && row.delete === 'no')
    .map(([key]) => key.replace(/^\//, ''))
  const caveat =
    unknown > 0
      ? ` ${unknown} of ${resourceTypes * VERBS.length} reviews could not be evaluated and read as unknown.`
      : ''

  return (
    `Access (from the cluster authorizer): may create ${byVerb.create} of ${resourceTypes} resource types, ` +
    `read ${reads}, update ${byVerb.update}, delete ${byVerb.delete}; view ${access.view}, edit ${access.edit}, admin ${access.admin}. ` +
    `Provision: ${provision || 'no offerings served'}.` +
    (oddities.length > 0
      ? ` Create without delete on ${oddities.slice(0, 5).join(', ')}${oddities.length > 5 ? ' and more' : ''}.`
      : '') +
    caveat
  )
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
