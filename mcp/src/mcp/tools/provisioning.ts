import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { kubernetesIdentityFor, type KubernetesIdentityMapping } from '../../auth/kubernetes-identity.js'
import type { KubernetesIdentity } from '../../clients/observability-kubernetes.js'
import type { ProvisioningService } from '../../services/provisioning-service.js'
import {
  formatAccessCheck,
  formatNamespaceReadiness,
  formatOfferings,
  formatProvisioningPlatform,
  formatUnavailable
} from '../../services/provisioning-format.js'
import { callerSubject, type ToolCallContext } from './caller-scope.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'
import {
  checkAccessOutputShape,
  describeNamespaceReadinessOutputShape,
  describeProvisioningPlatformOutputShape,
  listOfferingsOutputShape
} from './provisioning-schemas.js'

export const DESCRIBE_PROVISIONING_PLATFORM_TOOL_NAME = 'describe_provisioning_platform'
export const LIST_OFFERINGS_TOOL_NAME = 'list_offerings'
export const DESCRIBE_NAMESPACE_READINESS_TOOL_NAME = 'describe_namespace_readiness'
export const CHECK_ACCESS_TOOL_NAME = 'check_access'

const OFFERING_IDS = [
  'postgres',
  'dragonfly',
  'mongodb',
  'rabbitmq',
  'redpanda',
  'opensearch',
  'elasticsearch',
  'emqx',
  'bucket'
] as const

const namespaceName = z.string().trim().min(1).max(63)

export interface ProvisioningToolDependencies {
  service: Pick<
    ProvisioningService,
    | 'maxNamespaces'
    | 'describeProvisioningPlatform'
    | 'listOfferings'
    | 'describeNamespaceReadiness'
    | 'checkAccess'
  >
  identityMapping: KubernetesIdentityMapping
  audit?: (line: string) => void
}

export function registerProvisioningTools(
  server: McpServer,
  dependencies: ProvisioningToolDependencies
): void {
  const { service, identityMapping } = dependencies
  const audit = dependencies.audit ?? (() => undefined)
  // Identity comes only from the verified transport context. An unauthenticated
  // call (stdio, auth off) still gets every fact, with permission verdicts
  // reported as unknown rather than refused.
  const identityOf = (context: ToolCallContext | undefined): KubernetesIdentity | null => {
    const resolved = kubernetesIdentityFor(context?.authInfo, identityMapping)

    return resolved.ok ? resolved.identity : null
  }

  server.registerTool(
    DESCRIBE_PROVISIONING_PLATFORM_TOOL_NAME,
    {
      title: 'Describe the provisioning platform',
      description:
        'Use for an initial interpreted overview when planning provisioning or choosing platform capabilities. Returns cluster facts for provisioning: storage classes and what each implies for data, zones and ' +
        'schedulable nodes, priority classes, the published ingress domain and TLS advice, enforced admission ' +
        'policies and the tenant label they scope on, Kyverno policies, the network policy engine and whether ' +
        'the Prometheus operator is present. Everything is discovered from the cluster; an optional component ' +
        'that is absent degrades one fact rather than the answer. Read-only. For raw CRD and catalog listings ' +
        'use list_custom_resource_definitions, list_ingress_classes, list_cluster_issuers and list_priority_classes.',
      inputSchema: {},
      outputSchema: describeProvisioningPlatformOutputShape,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, context) => {
      const result = await service.describeProvisioningPlatform()

      audit(auditLine(DESCRIBE_PROVISIONING_PLATFORM_TOOL_NAME, context, result.status))

      return result.status === 'ok'
        ? toolResult(
            formatProvisioningPlatform(result),
            z.object(describeProvisioningPlatformOutputShape).parse(result)
          )
        : toolResult(formatUnavailable(result), result)
    }
  )

  server.registerTool(
    LIST_OFFERINGS_TOOL_NAME,
    {
      title: 'List provisionable offerings',
      description:
        'Use to choose a supported database, cache, queue or object-store offering; supply offering to narrow the catalog and namespace to check creation permissions. Returns each offering with whether it is ' +
        'actually available on this cluster and, when it is not, why, plus the admission defaults that ' +
        'rewrite its resources on create, each with what its policy says it requires. Presets describe sizing intent, not configured replica counts, placement or backups; discover applicable policies before selecting those settings. With `namespace`, each offering also ' +
        'carries whether the cluster authorizer lets you create it there, checked as the verified caller for ' +
        'every resource the offering needs, with enforced admission policies considered. Read-only.',
      inputSchema: {
        offering: z.enum(OFFERING_IDS).optional(),
        namespace: namespaceName.optional()
      },
      outputSchema: listOfferingsOutputShape,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ offering, namespace }, context) => {
      const result = await service.listOfferings(identityOf(context), offering, namespace)

      audit(
        auditLine(
          LIST_OFFERINGS_TOOL_NAME,
          context,
          result.status,
          [offering, namespace].filter(Boolean).join(' ')
        )
      )

      return result.status === 'ok'
        ? toolResult(formatOfferings(result), result)
        : toolResult(formatUnavailable(result), result)
    }
  )

  server.registerTool(
    DESCRIBE_NAMESPACE_READINESS_TOOL_NAME,
    {
      title: 'Describe namespace readiness',
      description:
        'Use before provisioning in known namespaces to assess readiness and constraints. Pass only relevant namespaces; add offering for an offering-specific creation check. Returns quota and remaining headroom, LimitRange defaults, network posture and ' +
        'any policies that select on an exact instance name, Pod Security enforcement, the hostnames the ' +
        'namespace may claim, any container registry published from the namespace with the skaffold.env ' +
        'to build against it, and your access there as the cluster authorizer reports it (per resource type ' +
        'as a plain creatableResources array, without a permission matrix). With `offering`, whether you ' +
        'may create that offering there. Namespaces where you may not list pods are withheld, not empty. ' +
        'Read-only.',
      inputSchema: {
        namespaces: z.array(namespaceName).min(1).max(service.maxNamespaces),
        offering: z.enum(OFFERING_IDS).optional()
      },
      outputSchema: describeNamespaceReadinessOutputShape,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ namespaces, offering }, context) => {
      const result = await service.describeNamespaceReadiness(identityOf(context), namespaces, offering)

      audit(auditLine(DESCRIBE_NAMESPACE_READINESS_TOOL_NAME, context, result.status, namespaces.join(',')))

      if (result.status !== 'ok') return toolResult(formatUnavailable(result), result)

      // Keep the internal reviews for offering checks, but expose only names
      // the caller can create. Do not modify shared/cached service results.
      const text = formatNamespaceReadiness(result, { includeAccessSummary: false })
      const structuredContent = {
        ...result,
        namespaces: result.namespaces.map(({ access, ...fact }) => ({
          ...fact,
          creatableResources: access
            ? Object.entries(access.matrix)
                .filter(([, row]) => row.create === 'yes')
                .map(([name]) => name)
                .sort()
            : null
        }))
      }

      return toolResult(text, structuredContent)
    }
  )

  server.registerTool(
    CHECK_ACCESS_TOOL_NAME,
    {
      title: 'Check one permission',
      description:
        'Use before a specific operation to check authorization; namespace visibility alone is insufficient. Supply API group, plural resource name and verb (plus namespace/name when applicable). Asks the cluster authorizer, as the verified caller, whether the operation is allowed: ' +
        'any group and resource, cluster-scoped or in a namespace, subresources such as pods/log, a named ' +
        'object. Discovered enforced admission constraints are reported alongside; an ' +
        'RBAC yes does not guarantee that create, update or delete will pass admission, including conditions this tool cannot evaluate. For create and update it also lists the mutating admission ' +
        'policies that rewrite the object, with what each says it requires, such as a Secret to provision first. ' +
        'Use it for anything outside the offering catalog. Read-only.',
      inputSchema: {
        verb: z.enum([
          'get',
          'list',
          'watch',
          'create',
          'update',
          'patch',
          'delete',
          'deletecollection',
          'proxy'
        ]),
        group: z.string().trim().max(253).default(''),
        resource: z.string().trim().min(1).max(253),
        subresource: z.string().trim().min(1).max(63).optional(),
        namespace: namespaceName.optional(),
        name: z.string().trim().min(1).max(253).optional()
      },
      outputSchema: checkAccessOutputShape,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (input, context) => {
      const result = await service.checkAccess(identityOf(context), input)

      audit(
        auditLine(
          CHECK_ACCESS_TOOL_NAME,
          context,
          result.status === 'ok' ? result.verdict : result.status,
          `${input.verb} ${input.resource}.${input.group || 'core'}${input.namespace ? ` ns=${input.namespace}` : ''}`
        )
      )

      return result.status === 'ok'
        ? toolResult(formatAccessCheck(result, input), result)
        : toolResult(formatUnavailable(result), result)
    }
  )
}

// Both forms, always: the markdown is what a human ends up reading, the
// structured content is what an agent branches on.
function toolResult(text: string, structuredContent: object) {
  return {
    structuredContent: { ...structuredContent },
    content: [{ type: 'text' as const, text }]
  }
}

function auditLine(
  tool: string,
  context: ToolCallContext | undefined,
  status: string,
  argument?: string
): string {
  const subject = callerSubject(context)

  return `[mcp] tool=${tool} sub=${subject}${argument ? ` arg=${argument}` : ''} -> ${status}`
}
