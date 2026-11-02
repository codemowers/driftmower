import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright-core'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createBearerAuthenticator } from '../src/auth/bearer.js'
import { startHttpTransport } from '../src/mcp/transports/http.js'

const keys = await generateKeyPair('RS256', { extractable: true })
const publicKey = { ...(await exportJWK(keys.publicKey)), kid: 'browser-test', alg: 'RS256', use: 'sig' }
const pending = new Map<string, URLSearchParams>()
let issuer = ''
let appUrl = ''
let badAudience = false
let lifetime = 3600
const calls: string[] = []
const usageCalls: { name: string; args: Record<string, unknown> }[] = []
let actionsEnabled = false
const mutations: { name: string; args: Record<string, unknown> }[] = []
let exchanges = 0
let app: Server | undefined
const oidc = createServer((req, res) => {
  res.setHeader('cross-origin-opener-policy', 'same-origin')
  res.setHeader('access-control-allow-origin', appUrl || '*')
  res.setHeader('access-control-allow-headers', 'content-type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()

    return
  }

  const url = new URL(req.url ?? '/', issuer)
  const json = (body: unknown) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }

  if (url.pathname === '/.well-known/openid-configuration') {
    json({
      issuer,
      authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256']
    })
  } else if (url.pathname === '/authorize') {
    assert.equal(url.searchParams.get('resource'), appUrl + '/mcp')
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(url.searchParams.get('nonce'))
    const code = randomUUID()

    pending.set(code, url.searchParams)
    const callback = new URL(url.searchParams.get('redirect_uri')!)

    callback.searchParams.set('code', code)
    callback.searchParams.set('state', url.searchParams.get('state')!)
    res.writeHead(302, { location: callback.href })
    res.end()
  } else if (url.pathname === '/jwks') json({ keys: [publicKey] })
  else if (url.pathname === '/token') {
    void (async () => {
      const chunks: Uint8Array[] = []

      for await (const chunk of req) chunks.push(chunk)
      const body = new URLSearchParams(Buffer.concat(chunks).toString())
      const auth = pending.get(body.get('code')!)

      assert.ok(auth, 'authorization code must be single-use')
      pending.delete(body.get('code')!)
      assert.equal(body.get('grant_type'), 'authorization_code')
      assert.equal(body.get('client_id'), 'web-test')
      assert.equal(body.get('client_secret'), null)
      assert.equal(body.get('resource'), appUrl + '/mcp')
      assert.equal(
        createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
        auth.get('code_challenge')
      )
      exchanges++
      const token = await new SignJWT({ groups: ['testers'], email: 'test@example.test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'browser-test' })
        .setSubject('browser-user')
        .setIssuer(issuer)
        .setAudience(appUrl + '/mcp')
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + lifetime)
        .sign(keys.privateKey)
      const idToken = await new SignJWT({ nonce: auth.get('nonce'), name: 'Browser Tester' })
        .setProtectedHeader({ alg: 'RS256', kid: 'browser-test' })
        .setSubject('browser-user')
        .setIssuer(issuer)
        .setAudience(badAudience ? 'wrong-client' : 'web-test')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey)

      json({
        access_token: token,
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: lifetime,
        scope: 'openid profile email groups namespaces'
      })
    })().catch(error => {
      process.stderr.write(String(error) + '\n')
      res.writeHead(500)
      res.end()
    })
  } else {
    res.writeHead(404)
    res.end()
  }
})

await new Promise<void>(resolve => oidc.listen(0, '127.0.0.1', resolve))
issuer = `http://127.0.0.1:${(oidc.address() as AddressInfo).port}`
const authenticator = createBearerAuthenticator(
  { issuer, publicUrl: 'http://localhost', jwksUri: issuer + '/jwks' },
  '/mcp',
  async () => keys.publicKey
)
// The public URL is filled after the server gets its ephemeral port.
const deferredAuthenticator = {
  ...authenticator,
  authenticate: async (headers: Parameters<typeof authenticator.authenticate>[0]) =>
    createBearerAuthenticator(
      { issuer, publicUrl: appUrl, jwksUri: issuer + '/jwks' },
      '/mcp',
      async () => keys.publicKey
    ).authenticate(headers)
}
const ui = { issuer, clientId: 'web-test', resource: '' }

app = await startHttpTransport(
  () => {
    const server = new McpServer({ name: 'browser-test', version: '1' })
    const register = (name: string, result: Record<string, unknown>) =>
      server.registerTool(
        name,
        {
          inputSchema: {},
          outputSchema: z.object({ namespaces: z.array(z.string()).optional() }).passthrough()
        },
        async (_args, context) => {
          assert.equal(context.authInfo?.extra?.sub, 'browser-user')
          calls.push(name)

          return {
            structuredContent: result,
            content: [{ type: 'text' as const, text: JSON.stringify(result) }]
          }
        }
      )

    register('get_workloads', {
      workloads: [
        {
          namespace: 'demo',
          name: 'app',
          uid: 'app-uid',
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          pods: ['app-0']
        },
        {
          namespace: 'demo',
          name: 'database',
          uid: 'db-uid',
          apiVersion: 'postgresql.cnpg.io/v1',
          kind: 'Cluster',
          pods: ['db-1']
        },
        {
          namespace: 'demo',
          name: 'batch',
          uid: 'job-uid',
          apiVersion: 'batch/v1',
          kind: 'Job',
          pods: ['batch-0']
        },
        { namespace: 'demo', name: 'schedule', uid: 'cron-uid', apiVersion: 'batch/v1', kind: 'CronJob' },
        {
          namespace: 'demo',
          name: 'cache',
          uid: 'cache-uid',
          apiVersion: 'dragonflydb.io/v1alpha1',
          kind: 'Dragonfly'
        },
        {
          namespace: 'demo',
          name: 'stream',
          uid: 'stream-uid',
          apiVersion: 'cluster.redpanda.com/v1alpha2',
          kind: 'Redpanda'
        },
        {
          namespace: 'demo',
          name: 'orphaned-workloads',
          uid: 'namespace:demo',
          apiVersion: 'v1',
          kind: 'Namespace',
          pods: ['standalone'],
          standalonePods: [{ name: 'standalone', uid: 'pod-uid' }]
        }
      ]
    })

    if (actionsEnabled)
      for (const name of ['restart_workload', 'terminate_pod'])
        server.registerTool(
          name,
          {
            inputSchema: {
              namespace: z.string(),
              name: z.string(),
              uid: z.string(),
              apiVersion: z.string().optional(),
              kind: z.string().optional()
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
              openWorldHint: false
            }
          },
          async (args, context) => {
            assert.equal(context.authInfo?.extra?.sub, 'browser-user')
            mutations.push({ name, args })

            return {
              structuredContent: { status: 'requested' },
              content: [
                {
                  type: 'text',
                  text: name === 'restart_workload' ? 'Restart requested.' : 'Termination requested.'
                }
              ]
            }
          }
        )

    register('list_accessible_namespaces', {
      namespaces: ['demo', '<img src=x onerror=alert(1)>'],
      clusterWide: false,
      unknown: [],
      truncated: false,
      note: null
    })
    server.registerTool(
      'list_admission_policies',
      { inputSchema: {}, description: 'Inspect **policies** with `names`.' },
      async (_args, context) => {
        assert.equal(context.authInfo?.extra?.sub, 'browser-user')
        calls.push('list_admission_policies')

        return {
          content: [
            {
              type: 'text' as const,
              text: 'name,description,kind,targets,bindings,conditional\npolicy,"Comma, and ""quote"" **bold** `code`\n\n- first\n- second\n\n[Docs](https://example.test/docs) [unsafe](javascript:alert%281%29) <img src=x onerror=alert(1)> <script>alert(1)</script>",MutatingAdmissionPolicy,pods.core,binding,false\n'
            }
          ]
        }
      }
    )
    register('list_ingress_classes', {
      ingressClasses: [{ name: 'test', controller: 'example.test/ingress', isDefault: true }]
    })
    register('list_storage_classes', {
      storageClasses: [{ name: 'fast', provisioner: 'test', isDefault: true }]
    })
    register('list_priority_classes', {
      priorityClasses: [
        { name: 'high', value: 1000, isDefault: false },
        { name: 'low', value: -100, isDefault: true }
      ]
    })
    server.registerTool('list_pods', { inputSchema: { namespace: z.string() } }, async ({ namespace }) => ({
      structuredContent: {
        namespace,
        pods: namespace === 'empty' ? [] : namespace === 'demo' ? ['api-1', 'worker-2'] : ['other-1']
      },
      content: [{ type: 'text', text: '' }]
    }))
    for (const name of [
      'get_pod_resource_usage',
      'get_cluster_resource_usage',
      'get_pod_resource_usage_history',
      'get_cluster_resource_usage_history'
    ]) {
      server.registerTool(
        name,
        {
          inputSchema: {
            namespace: z.string().optional(),
            pod: z.string().optional(),
            windowSeconds: z.number().default(300),
            perContainer: z.boolean().optional(),
            perNode: z.boolean().optional(),
            historySeconds: z.number().optional()
          }
        },
        async args => {
          usageCalls.push({ name, args })
          const historical = name.endsWith('_history')
          const statistics = {
            avg: 0.2,
            min: 0.1,
            max: 0.3,
            stddev: 0.08,
            sampleCount: 4,
            expectedSamples: 61,
            firstSampleAt: '2026-10-04T10:30:00Z',
            lastSampleAt: '2026-10-04T10:33:00Z'
          }
          const result = {
            source: 'prometheus',
            observedAt: '2026-10-04T11:00:00Z',
            windowSeconds: args.windowSeconds,
            metrics: {
              cpuUsed: {
                total: 0.25,
                unit: 'cores',
                ...(historical ? { statistics } : {}),
                ...(args.perNode || args.perContainer
                  ? {
                      breakdown: [
                        { labels: args.perNode ? { node: 'node-1' } : { container: 'web' }, value: 0.25 }
                      ]
                    }
                  : {})
              }
            },
            ...(historical
              ? {
                  history: {
                    requestedStart: '2026-10-04T10:00:00Z',
                    requestedEnd: '2026-10-04T11:00:00Z',
                    firstSampleAt: statistics.firstSampleAt,
                    lastSampleAt: statistics.lastSampleAt
                  }
                }
              : {})
          }

          return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
        }
      )
    }

    register('list_custom_resource_definitions', { customResources: [] })
    server.registerTool('echo', { inputSchema: { message: z.string() } }, async ({ message }) => ({
      content: [{ type: 'text' as const, text: message }]
    }))

    return server
  },
  { host: '127.0.0.1', port: 0, authenticator: deferredAuthenticator, webUi: ui }
)
appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
ui.resource = appUrl + '/mcp'
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox']
})

try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []

  page.on('pageerror', error => errors.push(error.message))
  context.on('page', popup => {
    popup.on('pageerror', error => errors.push('popup: ' + error.message))
    popup.on('console', message => {
      if (message.type() === 'error') errors.push('popup console: ' + message.text())
    })
  })
  await page.goto(appUrl + '/ui')
  assert.equal(exchanges, 0, 'opening the page must not start sign-in')
  await page.getByRole('button', { name: 'Sign in with OpenID' }).click()
  await page
    .getByRole('cell', { name: 'demo', exact: true })
    .waitFor({ timeout: 10000 })
    .catch(async error => {
      process.stderr.write(
        'Status: ' +
          (await page.locator('#status').innerText()) +
          '\nErrors: ' +
          JSON.stringify(errors) +
          '\n'
      )
      process.stderr.write(
        'Pages: ' +
          JSON.stringify(context.pages().map(p => p.url())) +
          ' Exchanges: ' +
          exchanges +
          ' Pending: ' +
          pending.size +
          '\n'
      )
      for (const popup of context.pages())
        process.stderr.write((await popup.locator('body').innerText()).slice(0, 1000) + '\n')
      throw error
    })
  assert.ok(calls.includes('list_accessible_namespaces'))
  assert.equal(await page.locator('#result img').count(), 0, 'untrusted tool output must be rendered as text')
  await page.getByRole('button', { name: 'Workloads', exact: true }).click()
  await page.locator('summary').filter({ hasText: 'Deployment.apps / app' }).waitFor()
  assert.equal(
    await page.locator('.workload-action').count(),
    0,
    'disabled mutation tools must have no action buttons'
  )
  await page.getByRole('button', { name: 'Admission policies', exact: true }).click()
  await page.locator('#result td strong').filter({ hasText: 'bold' }).waitFor()
  assert.equal(await page.locator('#result td code').innerText(), 'code')
  assert.deepEqual(await page.locator('#result td li').allTextContents(), ['first', 'second'])
  const docsLink = page.locator('#result td a').filter({ hasText: 'Docs' })

  assert.equal(await docsLink.getAttribute('href'), 'https://example.test/docs')
  assert.equal(await docsLink.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(await page.locator('#result td a').filter({ hasText: 'unsafe' }).getAttribute('href'), null)
  assert.equal(await page.locator('#result img, #result script, #result [onerror]').count(), 0)
  await page.locator('#filter').fill('second')
  assert.equal(await page.locator('#result tbody tr').count(), 1)
  await page.locator('#filter').fill('no matching policy')
  assert.equal(await page.locator('#result tbody tr').count(), 0)
  await page.locator('#filter').fill('')
  assert.deepEqual(await page.locator('#result th').allTextContents(), ['Kind', 'Name', 'Description'])
  assert.equal(
    await page.getByText('Credentials live only in this tab’s memory.', { exact: false }).count(),
    0
  )
  await page.getByRole('button', { name: 'Storage classes', exact: true }).click()
  await page.getByRole('cell', { name: 'fast', exact: true }).waitFor()
  assert.ok(!(await page.locator('#result th').allTextContents()).includes('Default'))
  await page.getByRole('button', { name: 'Priority classes', exact: true }).click()
  await page.getByRole('cell', { name: 'low', exact: true }).waitFor()
  assert.deepEqual(await page.locator('#result tbody tr td:first-child').allTextContents(), ['low', 'high'])
  assert.ok(!(await page.locator('#result th').allTextContents()).includes('isDefault'))
  await page.getByRole('button', { name: 'Ingress classes', exact: true }).click()
  await page.getByRole('cell', { name: 'example.test/ingress', exact: true }).waitFor()
  assert.deepEqual(await page.locator('#result th').allTextContents(), ['name', 'controller'])
  await page.getByRole('button', { name: 'Cluster resource usage', exact: true }).click()
  await page.getByRole('cell', { name: '0.25 cores', exact: true }).waitFor()
  assert.equal(usageCalls.at(-1)?.name, 'get_cluster_resource_usage')
  assert.equal(usageCalls.at(-1)?.args.perNode, false)
  assert.equal(await page.getByRole('columnheader', { name: 'Average', exact: true }).count(), 0)
  await page.getByLabel('Per-node breakdown').check()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('cell', { name: 'node: node-1', exact: true }).waitFor()
  await page.getByLabel('Historical analysis', { exact: true }).check()
  await page.getByLabel('History window', { exact: true }).selectOption('21600')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('columnheader', { name: 'Average', exact: true }).waitFor()
  assert.equal(usageCalls.at(-1)?.name, 'get_cluster_resource_usage_history')
  assert.equal(usageCalls.at(-1)?.args.historySeconds, 21600)
  await page.getByRole('button', { name: 'Pod resource usage', exact: true }).click()
  await page.getByRole('cell', { name: 'container: web', exact: true }).waitFor()
  assert.equal(usageCalls.at(-1)?.name, 'get_pod_resource_usage')
  assert.equal(usageCalls.at(-1)?.args.namespace, 'demo')
  assert.equal(usageCalls.at(-1)?.args.pod, 'api-1')
  assert.deepEqual(
    await page
      .locator('#pod-options option')
      .evaluateAll(options => options.map(option => option.getAttribute('value'))),
    ['api-1', 'worker-2']
  )
  const beforeEmpty = usageCalls.length

  await page.getByRole('combobox', { name: 'Namespace', exact: true }).fill('empty')
  await page.getByRole('combobox', { name: 'Namespace', exact: true }).dispatchEvent('change')
  await page
    .getByText(
      'No current pod selected. Choose another namespace or enter a known pod name for historical analysis.',
      { exact: true }
    )
    .waitFor()
  assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true)
  assert.equal(usageCalls.length, beforeEmpty)
  await page.getByRole('combobox', { name: 'Namespace', exact: true }).fill('second')
  await page.getByRole('combobox', { name: 'Namespace', exact: true }).dispatchEvent('change')
  await page.waitForFunction(
    () => globalThis.document.querySelector<HTMLInputElement>('#pod')?.value === 'other-1'
  )
  await page.getByRole('combobox', { name: 'Pod name', exact: true }).fill('finished-job-1')
  await page.getByLabel('Historical analysis', { exact: true }).check()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('columnheader', { name: 'Average', exact: true }).waitFor()
  assert.equal(usageCalls.at(-1)?.name, 'get_pod_resource_usage_history')
  assert.equal(usageCalls.at(-1)?.args.pod, 'finished-job-1')
  await page.getByRole('button', { name: 'Tool explorer', exact: true }).click()
  await page.locator('#tool').selectOption('list_admission_policies')
  await page.locator('#tool-description strong').filter({ hasText: 'policies' }).waitFor()
  assert.equal(await page.locator('#tool-description code').innerText(), 'names')
  await page.locator('#tool').selectOption('echo')
  await page.locator('#arguments').fill('{"message":"hello from browser"}')
  await page.getByRole('button', { name: 'Call tool', exact: true }).click()
  await page.locator('#result').getByText('hello from browser', { exact: true }).waitFor()
  await page.locator('#tool').selectOption('get_pod_resource_usage')
  await page.getByRole('combobox', { name: 'Namespace', exact: true }).fill('demo')
  await page.getByRole('combobox', { name: 'Namespace', exact: true }).dispatchEvent('change')
  await page.waitForFunction(
    () => globalThis.document.querySelector<HTMLInputElement>('#pod')?.value === 'api-1'
  )
  await page.getByRole('combobox', { name: 'Pod name', exact: true }).fill('worker-2')
  await page.getByRole('combobox', { name: 'Pod name', exact: true }).dispatchEvent('change')
  assert.equal(JSON.parse(await page.locator('#arguments').inputValue()).pod, 'worker-2')
  assert.equal(JSON.parse(await page.locator('#arguments').inputValue()).namespace, 'demo')
  assert.deepEqual(
    await page.evaluate(() => [
      globalThis.localStorage.length,
      globalThis.sessionStorage.length,
      globalThis.document.cookie
    ]),
    [0, 0, '']
  )
  const storage = await context.storageState()

  assert.equal(storage.cookies.length, 0)
  assert.equal(storage.origins.length, 0)
  const beforeReload = exchanges

  await page.reload()
  await page.getByRole('button', { name: 'Sign in with OpenID' }).waitFor()
  assert.equal(exchanges, beforeReload, 'reload must discard credentials and wait for sign-in')
  assert.equal(await page.locator('#result').innerText(), '')
  actionsEnabled = true
  await page.getByRole('button', { name: 'Sign in with OpenID' }).click()
  await page.getByRole('cell', { name: 'demo', exact: true }).waitFor()
  assert.ok(exchanges > beforeReload, 'manual sign-in must obtain fresh credentials')
  await page.getByRole('button', { name: 'Workloads', exact: true }).click()
  const appOwner = page
    .locator('.workload-owner')
    .filter({ has: page.locator('summary').filter({ hasText: 'Deployment.apps / app' }) })

  await appOwner.locator('summary').click()
  assert.equal(
    await page.locator('.workload-action').count(),
    5,
    'Deployment, CNPG, Dragonfly, Redpanda and standalone Pod get actions'
  )
  page.once('dialog', dialog => void dialog.dismiss())
  await page.getByRole('button', { name: 'Restart Deployment app', exact: true }).click()
  assert.equal(mutations.length, 0, 'cancelled confirmation must never call a mutating tool')
  page.once('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: 'Restart Deployment app', exact: true }).click()
  await page.getByText('Restart requested.', { exact: true }).waitFor()
  assert.deepEqual(mutations[0], {
    name: 'restart_workload',
    args: { namespace: 'demo', name: 'app', uid: 'app-uid', apiVersion: 'apps/v1', kind: 'Deployment' }
  })
  await page
    .locator('.workload-owner > summary')
    .filter({ hasText: 'Namespace / orphaned-workloads' })
    .click()
  page.once('dialog', dialog => void dialog.accept())
  await page.getByRole('button', { name: 'Terminate standalone', exact: true }).click()
  await page.getByText('Termination requested.', { exact: true }).waitFor()
  assert.deepEqual(mutations[1], {
    name: 'terminate_pod',
    args: { namespace: 'demo', name: 'standalone', uid: 'pod-uid' }
  })
  await page.getByRole('button', { name: 'Tool explorer', exact: true }).click()
  await page.locator('#tool').selectOption('restart_workload')
  await page.locator('#arguments').fill(
    JSON.stringify({
      namespace: 'demo',
      name: 'app',
      uid: 'app-uid',
      apiVersion: 'apps/v1',
      kind: 'Deployment'
    })
  )
  page.once('dialog', dialog => void dialog.dismiss())
  await page.getByRole('button', { name: 'Call tool', exact: true }).click()
  await page.getByText('Action cancelled.', { exact: true }).waitFor()
  assert.equal(mutations.length, 2, 'tool explorer must also confirm mutating calls')

  await page.getByRole('button', { name: 'Forget credentials' }).click()
  await page.getByRole('button', { name: 'Sign in with OpenID' }).waitFor()
  assert.equal(await page.locator('#raw-result').innerText(), '')
  badAudience = true
  await page.getByRole('button', { name: 'Sign in with OpenID' }).click()
  await page.locator('#status[data-error="true"]').waitFor()
  assert.match(await page.locator('#status').innerText(), /aud|claim/i)
  badAudience = false
  lifetime = 2
  await page.getByRole('button', { name: 'Sign in with OpenID' }).click()
  await page.getByRole('button', { name: 'Forget credentials' }).waitFor()
  await page.getByText('Credentials expired. Sign in again.', { exact: true }).waitFor()
  lifetime = 3600
  await page.close()
  const beforeReopen = exchanges
  const fresh = await context.newPage()

  await fresh.goto(appUrl + '/ui')
  await fresh.getByRole('button', { name: 'Sign in with OpenID' }).waitFor()
  assert.equal(exchanges, beforeReopen, 'a new tab must wait for manual sign-in')
  await fresh.getByRole('button', { name: 'Sign in with OpenID' }).click()
  await fresh.getByRole('cell', { name: 'demo', exact: true }).waitFor()
  assert.ok(exchanges > beforeReopen, 'a new tab must sign in again rather than reuse credentials')
  const blockedContext = await browser.newContext()

  await blockedContext.addInitScript(() => {
    globalThis.open = () => null
  })
  const blocked = await blockedContext.newPage()

  await blocked.goto(appUrl + '/ui')
  await blocked.getByRole('button', { name: 'Sign in with OpenID' }).waitFor()
  assert.equal(await blocked.getByRole('button', { name: 'Sign in with OpenID' }).isEnabled(), true)
  assert.equal(await blocked.locator('#result').innerText(), '')
  await blockedContext.close()
  assert.ok(exchanges >= 4)
  assert.deepEqual(errors, [])
  process.stdout.write(
    'Browser smoke passed: PKCE/OpenID popup, real MCP calls, policy CSV, tool inputs, safe rendering, usage controls, namespace/pod comboboxes, gated workload actions and confirmations, manual sign-in without automatic popups, no storage, reload/sign-out/tab cleanup, invalid audience and expiry.\n'
  )
} finally {
  await browser.close()
  app.closeAllConnections()
  oidc.closeAllConnections()
  await Promise.all([
    new Promise<void>(resolve => app!.close(() => resolve())),
    new Promise<void>(resolve => oidc.close(() => resolve()))
  ])
}
