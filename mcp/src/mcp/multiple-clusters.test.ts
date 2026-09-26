import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { afterEach, expect, it } from 'vitest'
import { createMcpServer } from './create-server.js'
import { clusterIdentity } from '../domain/cluster-identity.js'
import { ENGINEERING_ADVISORIES } from '../advisory/software-engineering.js'
import { renderLandingPage } from '../http/landing.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

it('keeps identity, context instructions, snippets and effective guidance specific to each server', async () => {
  for (const provider of ['codemowers.io', 'other.example']) {
    const cluster = clusterIdentity(
      `ee-west-1.${provider}`,
      `https://api.${provider}:6443`,
      `https://mcp.${provider}`
    )
    const advisories = ENGINEERING_ADVISORIES.map(section =>
      section.path === 'deploying/networking'
        ? { ...section, source: 'override' as const, text: `Use the ingress at ${provider}.` }
        : section
    )
    const server = createMcpServer({ cluster, advisories })
    const client = new Client({ name: 'test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanup.push(async () => {
      await client.close()
      await server.close()
    })
    expect(client.getServerVersion()?.name).toBe(`driftmower-ee-west-1-${provider.replaceAll('.', '-')}`)
    expect(client.getInstructions()).toContain(cluster.apiUrl)
    expect(client.getInstructions()).toContain('explicit --context')
    expect(client.getInstructions()).toContain(`${cluster.id}/<namespace>`)
    expect(client.getInstructions()).toContain('Skaffold deploy.kubeContext')
    expect(client.getInstructions()).toContain('ask the user')
    const identity = await client.callTool({ name: 'get_cluster_identity', arguments: {} })

    expect(identity.structuredContent).toMatchObject({ cluster })
    const advice = await client.callTool({
      name: 'get_engineering_advisory',
      arguments: { path: 'deploying/networking' }
    })
    const resource = await client.readResource({ uri: 'engineering://advisory/deploying/networking' })

    expect(advice.structuredContent).toMatchObject({
      cluster,
      source: 'override',
      markdown: expect.stringContaining(provider)
    })
    expect(resource.contents[0]).toMatchObject({
      text: z.object({ markdown: z.string() }).parse(advice.structuredContent).markdown
    })
    const html = renderLandingPage(true, `https://mcp.${provider}/mcp`, {
      cluster,
      advisories,
      oauthClientId: `${provider}.client`
    })

    expect(html).toContain(`codex mcp add ${cluster.mcpServerName} --url`)
    expect(html).toContain(` ${cluster.mcpServerName} &#39;https://mcp.${provider}/mcp&#39;`)
    expect(html).toContain(`--client-id &#39;${provider}.client&#39;`)
    expect(html).toContain(`Use the ingress at ${provider}.`)
    expect(html).toContain('Cluster override')
    expect(html).toContain(cluster.apiUrl)
    expect(html).not.toContain('kube-system.driftmower-mcp')
  }
})

it('reports unknown identity instead of treating an MCP hostname as a Kubernetes endpoint', async () => {
  const cluster = clusterIdentity(null, null, 'https://mcp.example')

  expect(cluster).toEqual({ id: null, apiUrl: null, mcpServerName: 'driftmower-mcp-example' })
  expect(renderLandingPage(true, 'https://mcp.example/mcp', { cluster })).not.toContain('--client-id')
})
