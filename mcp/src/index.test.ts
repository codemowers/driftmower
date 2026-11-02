import { setTimeout, clearTimeout } from 'node:timers'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'

it('exits nonzero and releases health after an MCP listener startup failure', async () => {
  const occupied = createServer()
  const reserve = createServer()

  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = (occupied.address() as AddressInfo).port
  const healthPort = (reserve.address() as AddressInfo).port

  await new Promise<void>(resolve => reserve.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: {
      ...process.env,
      NODE_CONFIG_ENV: 'default',
      DRIFTMOWER_MCP_TRANSPORT: 'http',
      DRIFTMOWER_MCP_HOST: '127.0.0.1',
      DRIFTMOWER_MCP_PORT: String(port),
      DRIFTMOWER_MCP_HEALTH_PORT: String(healthPort),
      DRIFTMOWER_BE_ENABLED: 'false',
      MCP_AUTH_ENABLED: 'false',
      KUBERNETES_TOKEN_FILE: '/tmp/driftmower-test-no-token'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''

  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  const exited = once(child, 'exit')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 4000)

  try {
    const [code, signal] = await exited

    expect(signal).toBeNull()
    expect(code).toBe(1)
    expect(stderr).toContain('EADDRINUSE')
    await expect(fetch(`http://127.0.0.1:${healthPort}/readyz`)).rejects.toThrow()
  } finally {
    clearTimeout(deadline)

    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')

    await new Promise<void>(resolve => occupied.close(() => resolve()))
  }
})
