import { clusterIdentitySchema, type ClusterIdentity } from '../../domain/cluster-identity.js'
import type { EngineeringAdvisory } from '../../advisory/software-engineering.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ENGINEERING_ADVISORIES, advisoryMarkdown, advisoryUri } from '../../advisory/software-engineering.js'
import { READ_ONLY_ANNOTATIONS } from '../tools/read-only-annotations.js'

export function registerEngineeringAdvisory(
  server: McpServer,
  advisories: EngineeringAdvisory[] = ENGINEERING_ADVISORIES,
  cluster: ClusterIdentity = { id: null, apiUrl: null, mcpServerName: 'driftmower' }
): void {
  const index = {
    path: 'index',
    source: 'generated' as const,
    title: 'Software engineering advisory',
    text:
      'Project software engineering guidance. Read the shared sections alongside the language-specific sections. For operator provisioning, read crds/<lowercase-kind>.<api-group> (for example crds/cluster.postgresql.cnpg.io). TODO placeholders identify missing guidance.\n\n' +
      advisories
        .map(
          section =>
            `- [${section.path}](${advisoryUri(section.path)}) — ${section.title} (${section.source})`
        )
        .join('\n')
  }
  const sections = [index, ...advisories]

  for (const section of sections) {
    server.registerResource(
      section.path,
      advisoryUri(section.path),
      {
        title: section.title,
        description: `Software engineering advisory for ${cluster.id ?? 'unconfigured cluster'}: ${section.title} (${section.source})`,
        mimeType: 'text/markdown'
      },
      async uri => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: advisoryMarkdown(section) }]
      })
    )
  }

  server.registerTool(
    'get_engineering_advisory',
    {
      title: 'Read software engineering advisory',
      description:
        'Read platform software engineering guidance for developing, building, and deploying applications. Omit path for the index. For operator provisioning, use crds/<lowercase-kind>.<api-group>, for example crds/cluster.postgresql.cnpg.io; these documents include manifests and client wiring. Uses this cluster’s effective guidance: administrator overrides replace bundled documents at the same path. Includes explicit TODO placeholders for unfinished guidance. Also available as engineering://advisory/ MCP resources.',
      inputSchema: {
        path: z.enum(['index', ...advisories.map(section => section.path)]).default('index')
      },
      outputSchema: {
        path: z.string(),
        uri: z.string(),
        title: z.string(),
        markdown: z.string(),
        source: z.enum(['bundled', 'override', 'generated']),
        cluster: clusterIdentitySchema
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ path }) => {
      const section = sections.find(candidate => candidate.path === path)!
      const markdown = advisoryMarkdown(section)

      return {
        structuredContent: {
          path,
          uri: advisoryUri(path),
          title: section.title,
          markdown,
          source: section.source,
          cluster
        },
        content: [
          { type: 'text', text: markdown },
          { type: 'text', text: JSON.stringify({ cluster, source: section.source }) }
        ]
      }
    }
  )
}
