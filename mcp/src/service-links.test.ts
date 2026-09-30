import { describe, expect, it } from 'vitest'
import { dropServiceLinkValues } from './service-links.js'

describe('dropServiceLinkValues', () => {
  it('drops an injected service-link URL and keeps a real port', () => {
    const injected = {
      DRIFTMOWER_MCP_PORT: 'tcp://10.248.12.7:3000',
      DRIFTMOWER_MCP_SERVICE_HOST: '10.248.12.7'
    }

    expect(dropServiceLinkValues(injected)).toEqual(['DRIFTMOWER_MCP_PORT'])
    expect(injected).toEqual({ DRIFTMOWER_MCP_SERVICE_HOST: '10.248.12.7' })

    const configured = { DRIFTMOWER_MCP_PORT: '8080', DRIFTMOWER_MCP_HEALTH_PORT: '8081' }

    expect(dropServiceLinkValues(configured)).toEqual([])
    expect(configured).toEqual({ DRIFTMOWER_MCP_PORT: '8080', DRIFTMOWER_MCP_HEALTH_PORT: '8081' })
    expect(dropServiceLinkValues({})).toEqual([])
  })

  it('covers the health port, which a Service named driftmower-mcp-health would shadow', () => {
    const injected = { DRIFTMOWER_MCP_HEALTH_PORT: 'tcp://10.248.12.8:3001', DRIFTMOWER_MCP_PORT: '3000' }

    expect(dropServiceLinkValues(injected)).toEqual(['DRIFTMOWER_MCP_HEALTH_PORT'])
    expect(injected).toEqual({ DRIFTMOWER_MCP_PORT: '3000' })
    expect(dropServiceLinkValues({})).toEqual([])
  })
})
