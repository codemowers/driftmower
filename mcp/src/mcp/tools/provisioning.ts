import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ProvisioningService } from '../../services/provisioning-service.js'
import {
  formatNamespaceReadiness,
  formatOfferings,
  formatUnavailable
} from '../../services/provisioning-format.js'
import { callerAccessToken, callerSubject, type ToolCallContext } from './caller-scope.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'
import { describeNamespaceReadinessOutputShape, listOfferingsOutputShape } from './provisioning-schemas.js'

export const DESCRIBE_CLUSTER_CAPABILITIES_TOOL_NAME = 'describe_cluster_capabilities'
export const LIST_OFFERINGS_TOOL_NAME = 'list_offerings'
export const DESCRIBE_NAMESPACE_READINESS_TOOL_NAME = 'describe_namespace_readiness'

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

// A stale deep link naming fifty namespaces must not fan out unbounded;
// driftmower-ui caps this too, and agreeing with it keeps the error honest.
const MAX_NAMESPACES = 12

export interface ProvisioningToolDependencies {
  provisioningService: ProvisioningService
  audit?: (line: string) => void
}

export function registerProvisioningTools(
  server: McpServer,
  dependencies: ProvisioningToolDependencies
): void {
  const { provisioningService } = dependencies
  const audit = dependencies.audit ?? (() => undefined)

  server.registerTool(
    LIST_OFFERINGS_TOOL_NAME,
    {
      title: 'List provisionable offerings',
      description:
        'Every database, cache, queue and object store this platform can provision, each with ' +
        'whether it is actually available on this cluster and, when it is not, why. Read-only.',
      inputSchema: {
        offering: z.enum(OFFERING_IDS).optional()
      },
      outputSchema: listOfferingsOutputShape,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ offering }, context) => {
      const result = await provisioningService.listOfferings(callerAccessToken(context), offering)

      audit(auditLine(LIST_OFFERINGS_TOOL_NAME, context, result.status, offering))

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
        'For one or more namespaces you can access: quota and remaining headroom, LimitRange ' +
        'defaults, network posture and any policies that select on an exact instance name, Pod ' +
        'Security enforcement, whether you may create things here, and the hostnames the ' +
        'namespace may claim. Read-only.',
      inputSchema: {
        namespaces: z.array(z.string().trim().min(1)).min(1).max(MAX_NAMESPACES)
      },
      outputSchema: describeNamespaceReadinessOutputShape,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ namespaces }, context) => {
      const result = await provisioningService.describeNamespaceReadiness(
        callerAccessToken(context),
        namespaces
      )

      audit(auditLine(DESCRIBE_NAMESPACE_READINESS_TOOL_NAME, context, result.status, namespaces.join(',')))

      return result.status === 'ok'
        ? toolResult(formatNamespaceReadiness(result), result)
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
