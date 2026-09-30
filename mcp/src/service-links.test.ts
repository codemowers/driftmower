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

    const configured = { DRIFTMOWER_MCP_PORT: '8080' }

    expect(dropServiceLinkValues(configured)).toEqual([])
    expect(configured).toEqual({ DRIFTMOWER_MCP_PORT: '8080' })
    expect(dropServiceLinkValues({})).toEqual([])
  })
})
