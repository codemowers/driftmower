import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const endpoint = process.env.MCP_TEST_URL
const health = process.env.MCP_HEALTH_URL

assert(endpoint && health, 'Compose smoke test requires MCP_TEST_URL and MCP_HEALTH_URL')
const client = new Client({ name: 'compose-smoke', version: '1.0.0' })

try {
  assert.equal((await fetch(`${health}/readyz`)).status, 200)
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  const tools = await client.listTools()

  assert(tools.tools.some(tool => tool.name === 'search_workloads'))
  const result = await client.callTool({ name: 'search_workloads', arguments: { query: 'cert-manager' } })

  assert(!result.isError, JSON.stringify(result))
  const content = result.structuredContent

  assert(content && typeof content === 'object' && 'matches' in content)
  assert(Array.isArray(content.matches) && content.matches.length > 0)
  const metrics = await (await fetch(`${health}/metrics`)).text()

  assert(metrics.includes('driftmower_mcp_sessions_total'))
  assert(metrics.includes('driftmower_http_requests_total'))
  process.stdout.write('Compose MCP/backend/metrics smoke test passed\n')
} finally {
  await client.close()
}
