import { restartResource } from '../domain/workload-actions.js'
import { workloadOwnerId, workloadYaml } from './workloads.js'
import { UserManager, InMemoryWebStorage, WebStorageStateStore } from 'oidc-client-ts'
import type { User } from 'oidc-client-ts'
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { resourceUsageTable } from './resource-usage.js'
import { argumentExample, parseCsv } from './results.js'
import { renderMarkdown } from './markdown.js'

const views = {
  namespaces: {
    title: 'Accessible namespaces',
    tool: 'list_accessible_namespaces',
    description:
      'Namespaces where Kubernetes lets your verified identity list pods. Visibility does not establish permission to change resources.'
  },
  workloads: {
    title: 'Workloads',
    tool: 'get_workloads',
    description:
      'Workloads and their dependencies grouped by top-level owner. Namespace entries contain unclaimed resources. Leave the namespace empty to inspect all accessible namespaces.'
  },
  policies: {
    title: 'Admission policies',
    tool: 'list_admission_policies',
    description:
      'Live policy descriptions, target resources and bindings. Targets are candidates; this catalog does not evaluate policy conditions.'
  },
  crds: {
    title: 'Custom resource definitions',
    tool: 'list_custom_resource_definitions',
    description:
      'Installed namespace-scoped APIs. Installed APIs do not establish operator health or caller permissions. Use the tool explorer to include cluster-scoped CRDs.'
  },
  ingress: {
    title: 'Ingress classes',
    tool: 'list_ingress_classes',
    description: 'Installed ingress classes and their controllers.'
  },
  issuers: {
    title: 'Cluster issuers',
    tool: 'list_cluster_issuers',
    description: 'Installed ClusterIssuers, their descriptions and reported readiness.'
  },
  priorities: {
    title: 'Priority classes',
    tool: 'list_priority_classes',
    description: 'Scheduling priority values and descriptions, sorted by value.'
  },
  storage: {
    title: 'Storage classes',
    tool: 'list_storage_classes',
    description: 'Live storage provisioning guidance and settings.'
  },
  clusterUsage: {
    title: 'Cluster resource usage',
    tool: 'get_cluster_resource_usage',
    description:
      'CPU, memory, filesystem and network usage. Enable per-node breakdown or historical analysis, then refresh.'
  },
  podUsage: {
    title: 'Pod resource usage',
    tool: 'get_pod_resource_usage',
    description:
      'Choose a namespace and pod to inspect CPU, memory, throttling, filesystem and network usage. Enter a deleted pod name to analyze its history.'
  },
  tools: {
    title: 'Tool explorer',
    tool: '',
    description:
      'Inspect the advertised input schema, enter arguments and call a tool as your signed-in identity.'
  }
}

type View = keyof typeof views
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id)

  if (!value) throw new Error('Missing UI element: ' + id)

  return value as T
}

function status(message: string, error = false): void {
  element('status').textContent = message
  element('status').dataset.error = String(error)
}

async function main(): Promise<void> {
  const response = await fetch('/ui/config', { cache: 'no-store', credentials: 'omit' })

  if (!response.ok) throw new Error('The web UI configuration is unavailable.')

  const config: { issuer: string; clientId: string; resource: string } = await response.json()
  // Both protocol state and user credentials use volatile storage. Never use
  // the library's default sessionStorage/localStorage or silent sign-in.
  const stateMemory = new InMemoryWebStorage()
  const userMemory = new InMemoryWebStorage()
  const manager = new UserManager({
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: new URL('/ui/callback', location.origin).href,
    response_type: 'code',
    scope: 'openid profile email groups namespaces',
    resource: config.resource,
    extraTokenParams: { resource: config.resource },
    stateStore: new WebStorageStateStore({ store: stateMemory }),
    userStore: new WebStorageStateStore({ store: userMemory }),
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
    staleStateAgeInSeconds: 300,
    popupWindowFeatures: { width: 600, height: 750 }
  })

  if (location.pathname === '/ui/callback') {
    try {
      // The OIDC library also supports a state-bound BroadcastChannel when
      // the provider isolates its popup with Cross-Origin-Opener-Policy.
      await manager.signinPopupCallback()
      // Erase the authorization code from the popup's history before closing.
      history.replaceState(null, '', '/ui/callback')
      window.close()
    } catch (error) {
      history.replaceState(null, '', '/ui/callback')
      status('Sign-in could not complete. ' + (error instanceof Error ? error.message : String(error)), true)
    }

    return
  }

  let user: User | null = null
  let client: Client | null = null
  let transport: StreamableHTTPClientTransport | null = null
  let tools: Tool[] = []
  let view: View = 'namespaces'
  let busy = false
  let generation = 0
  let knownNamespaces: string[] | null = null
  let pickerRevision = 0
  let pickerLoading = false
  let expiration: ReturnType<typeof setTimeout> | undefined
  let workloadRows: Record<string, unknown>[] = []
  const openWorkloadOwners = new Set<string>()
  let tableRows: string[][] = []
  let tableHeaders: string[] = []

  function updateControls(): void {
    element<HTMLButtonElement>('signin').disabled = busy
    element('signin').hidden = !!user
    element('signout').hidden = !user
    element('identity').textContent = user
      ? String(user.profile.name ?? user.profile.email ?? user.profile.sub)
      : 'Not signed in'
    element<HTMLButtonElement>('run').disabled =
      busy ||
      pickerLoading ||
      !client ||
      (view === 'podUsage' && !element<HTMLInputElement>('pod').value.trim())
    element<HTMLSelectElement>('tool').disabled = busy
    for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) button.disabled = busy
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      '.query-controls input, .query-controls select, .query-controls button'
    ))
      control.disabled = busy || !client
    for (const button of document.querySelectorAll<HTMLButtonElement>('.workload-action'))
      button.disabled = busy || !client
  }

  async function forget(message = 'Credentials discarded. Sign in to reconnect.'): Promise<void> {
    generation++
    clearTimeout(expiration)
    const oldClient = client

    client = null
    transport = null
    tools = []
    knownNamespaces = null
    pickerRevision++
    pickerLoading = false
    for (const id of ['namespace', 'pod']) element<HTMLInputElement>(id).value = ''
    for (const id of ['namespace-options', 'pod-options']) element(id).replaceChildren()
    element('picker-status').textContent = ''
    element('usage-summary').hidden = true
    user = null
    busy = false
    userMemory.clear()
    stateMemory.clear()
    element('result').replaceChildren()
    element('raw').hidden = true
    element('raw-result').textContent = ''
    element('tool').replaceChildren()
    element('schema').textContent = ''
    workloadRows = []
    openWorkloadOwners.clear()
    tableRows = []
    tableHeaders = []
    element('filter').hidden = true
    element('count').hidden = true
    status(message)
    updateControls()
    await oldClient?.close().catch(() => undefined)
  }

  async function workloadAction(
    tool: 'restart_workload' | 'terminate_pod',
    args: Record<string, unknown>
  ): Promise<void> {
    if (!client || busy) return

    const action = tool === 'restart_workload' ? 'Restart' : 'Terminate'
    const warning =
      tool === 'terminate_pod'
        ? ' This standalone pod will not be recreated by a controller.'
        : ' This may interrupt service.'

    if (
      !window.confirm(
        `${action} ${String(args.kind ?? 'Pod')} ${String(args.namespace)}/${String(args.name)}?${warning}`
      )
    )
      return

    const activeGeneration = generation
    const activeClient = client

    busy = true
    updateControls()
    status(`${action} requested…`)
    try {
      const result = (await activeClient.callTool({ name: tool, arguments: args })) as CallToolResult

      if (activeGeneration !== generation) return

      const message = result.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join(' ')

      if (result.isError) throw new Error(message || 'Workload action failed')

      busy = false
      updateControls()
      await run()

      if (activeGeneration === generation) status(message || `${action} requested.`)
    } catch (error) {
      if (activeGeneration === generation)
        status(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (activeGeneration === generation) {
        busy = false
        updateControls()
      }
    }
  }

  function actionButton(
    label: string,
    tool: 'restart_workload' | 'terminate_pod',
    args: Record<string, unknown>
  ): HTMLButtonElement {
    const button = document.createElement('button')

    button.type = 'button'
    button.className = 'workload-action'
    button.textContent = label
    button.disabled = busy || !client
    button.addEventListener('click', () => void workloadAction(tool, args))

    return button
  }

  function drawWorkloads(): void {
    const rendered = workloadYaml(workloadRows, element<HTMLInputElement>('filter').value)

    const rowsByOwner = new Map(workloadRows.map(row => [workloadOwnerId(row), row]))
    const wrapper = document.createElement('div')
    const filtering = !!element<HTMLInputElement>('filter').value.trim()

    for (const owner of rendered.owners) {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      const pre = document.createElement('pre')

      details.className = 'workload-owner'
      details.open = filtering || openWorkloadOwners.has(owner.id)
      details.addEventListener('toggle', () => {
        if (filtering || !details.isConnected) return

        if (details.open) openWorkloadOwners.add(owner.id)
        else openWorkloadOwners.delete(owner.id)
      })
      summary.textContent = owner.label
      pre.setAttribute('aria-label', owner.label + ' YAML')
      pre.textContent = owner.text
      details.append(summary)
      const row = rowsByOwner.get(owner.id)!
      const actions = document.createElement('div')

      actions.className = 'toolbar'

      if (
        tools.some(tool => tool.name === 'restart_workload') &&
        typeof row.apiVersion === 'string' &&
        typeof row.kind === 'string' &&
        typeof row.name === 'string' &&
        typeof row.uid === 'string' &&
        restartResource(row.apiVersion, row.kind)
      ) {
        const button = actionButton('Restart', 'restart_workload', {
          namespace: row.namespace,
          name: row.name,
          uid: row.uid,
          apiVersion: row.apiVersion,
          kind: row.kind
        })

        button.setAttribute('aria-label', `Restart ${row.kind} ${row.name}`)
        actions.append(button)
      }

      if (
        row.kind === 'Namespace' &&
        Array.isArray(row.standalonePods) &&
        tools.some(tool => tool.name === 'terminate_pod')
      )
        for (const pod of row.standalonePods) {
          if (!pod || typeof pod !== 'object' || typeof pod.name !== 'string' || typeof pod.uid !== 'string')
            continue

          const button = actionButton(`Terminate ${pod.name}`, 'terminate_pod', {
            namespace: row.namespace,
            name: pod.name,
            uid: pod.uid
          })

          actions.append(button)
        }

      if (actions.childElementCount) details.append(actions)

      details.append(pre)
      wrapper.append(details)
    }

    if (!rendered.shown) {
      const empty = document.createElement('p')

      empty.className = 'muted'
      empty.textContent = filtering ? 'No matching workloads.' : 'No workloads to display.'
      wrapper.append(empty)
    }

    element('result').replaceChildren(wrapper)
    element('filter').hidden = false
    element('count').hidden = false
    element('count').textContent = `${rendered.shown} / ${workloadRows.length} owners`
  }

  function drawTable(): void {
    const filter = element<HTMLInputElement>('filter').value.toLowerCase()
    const rows = tableRows.filter(row => row.some(cell => cell.toLowerCase().includes(filter)))
    const wrapper = document.createElement('div')

    wrapper.className = 'table-wrap'
    const table = document.createElement('table')
    const head = table.createTHead().insertRow()

    for (const heading of tableHeaders) {
      const cell = document.createElement('th')

      cell.scope = 'col'
      cell.textContent = heading
      head.append(cell)
    }

    const body = table.createTBody()

    for (const values of rows) {
      const row = body.insertRow()

      for (const [index, value] of values.entries()) {
        const cell = row.insertCell()

        if (tableHeaders[index]?.toLowerCase() === 'description') renderMarkdown(cell, value)
        else cell.textContent = value
      }
    }

    wrapper.append(table)
    element('result').replaceChildren(wrapper)
    element('filter').hidden = false
    element('count').hidden = false
    element('count').textContent = `${rows.length} / ${tableRows.length}`
  }

  function renderResult(result: CallToolResult): void {
    element('raw').hidden = false
    element('raw-result').textContent = JSON.stringify(result, null, 2)
    const structured = result.structuredContent

    tableRows = []
    tableHeaders = []

    element('usage-summary').hidden = true

    if ((view === 'clusterUsage' || view === 'podUsage') && structured && !result.isError) {
      const usage = resourceUsageTable(structured)

      tableHeaders = usage.headers
      tableRows = usage.rows
      element('usage-summary').textContent = usage.summary
      element('usage-summary').hidden = false
    } else if (view === 'workloads' && structured && Array.isArray(structured.workloads) && !result.isError) {
      workloadRows = structured.workloads.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
      )

      const currentOwners = new Set(workloadRows.map(workloadOwnerId))

      for (const id of openWorkloadOwners) if (!currentOwners.has(id)) openWorkloadOwners.delete(id)

      if (Array.isArray(structured.warnings) && structured.warnings.length) {
        element('usage-summary').textContent = structured.warnings
          .filter((warning): warning is string => typeof warning === 'string')
          .join('\n')
        element('usage-summary').hidden = false
        status('Inventory received with incomplete reads. See the notes below.')
      }

      drawWorkloads()

      return
    } else if (view === 'namespaces' && structured && Array.isArray(structured.namespaces)) {
      tableHeaders = ['Namespace']
      knownNamespaces = structured.namespaces
        .filter(
          (name): name is string => typeof name === 'string' && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(name)
        )
        .sort()
      tableRows = structured.namespaces.map(name => [String(name)])
      status(
        typeof structured.note === 'string' ? structured.note : `${tableRows.length} accessible namespace(s).`
      )
    } else if (view === 'storage' && structured && Array.isArray(structured.storageClasses)) {
      tableHeaders = ['Name', 'Description', 'Provisioner', 'Binding mode', 'Reclaim policy']
      tableRows = structured.storageClasses.map(item => {
        const row = item as Record<string, unknown>

        return ['name', 'description', 'provisioner', 'volumeBindingMode', 'reclaimPolicy'].map(key =>
          String(row[key] ?? 'Unspecified')
        )
      })
    } else if (structured && ['crds', 'ingress', 'issuers', 'priorities'].includes(view)) {
      const catalogs = {
        crds: ['customResources', ['kind', 'name', 'description']],
        ingress: ['ingressClasses', ['name', 'controller']],
        issuers: ['clusterIssuers', ['name', 'description', 'ready']],
        priorities: ['priorityClasses', ['name', 'description', 'value']]
      } as const
      const [key, columns] = catalogs[view as keyof typeof catalogs]

      tableHeaders = [...columns]
      const items = structured[key]

      if (view === 'priorities' && Array.isArray(items))
        items.sort(
          (a, b) =>
            Number((a as Record<string, unknown>).value) - Number((b as Record<string, unknown>).value) ||
            String((a as Record<string, unknown>).name).localeCompare(
              String((b as Record<string, unknown>).name)
            )
        )

      if (Array.isArray(items))
        tableRows = items.map(item =>
          columns.map(column => String((item as Record<string, unknown>)[column] ?? 'Unspecified'))
        )

      if (Array.isArray(structured.degraded) && structured.degraded.length)
        status(JSON.stringify(structured.degraded), true)
    } else if (view === 'policies') {
      const text = result.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n')
      const rows = parseCsv(text)

      const headers = rows.shift() ?? []

      tableHeaders = ['Kind', 'Name', 'Description']
      tableRows = rows
        .filter(row => row.length === headers.length)
        .map(row => ['kind', 'name', 'description'].map(key => row[headers.indexOf(key)] ?? ''))
      const notes = rows
        .filter(row => row.length !== headers.length)
        .flat()
        .filter(Boolean)

      if (notes.length) status(notes.join('\n'))
    }

    if (tableHeaders.length) drawTable()
    else {
      const pre = document.createElement('pre')

      pre.textContent = structured
        ? JSON.stringify(structured, null, 2)
        : result.content.map(item => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n\n')
      element('result').replaceChildren(pre)
      element('filter').hidden = true
      element('count').hidden = true
    }
  }

  function selectedTool(): Tool | undefined {
    const name = view === 'tools' ? element<HTMLSelectElement>('tool').value : views[view].tool

    return tools.find(tool => tool.name === name)
  }

  function targetFields(): { namespace: boolean; pod: boolean; requiredNamespace: boolean } {
    if (view === 'podUsage') return { namespace: true, pod: true, requiredNamespace: true }

    if (view === 'workloads') return { namespace: true, pod: false, requiredNamespace: false }

    const schema = view === 'tools' ? selectedTool()?.inputSchema : undefined
    const properties = schema?.properties as Record<string, unknown> | undefined

    return {
      namespace: !!properties?.namespace,
      pod: !!properties?.pod,
      requiredNamespace: !!schema?.required?.includes('namespace')
    }
  }

  function updateTargetFields(): void {
    const fields = targetFields()

    element('target-pickers').hidden = !fields.namespace && !fields.pod
    element('namespace-field').hidden = !fields.namespace
    element<HTMLInputElement>('namespace').placeholder =
      view === 'workloads' ? 'All accessible namespaces' : 'Select or enter namespace'
    element('pod-field').hidden = !fields.pod
    element('usage-controls').hidden = view !== 'clusterUsage' && view !== 'podUsage'

    if (view === 'tools') {
      try {
        const args = JSON.parse(element<HTMLTextAreaElement>('arguments').value)

        element<HTMLInputElement>('namespace').value =
          typeof args.namespace === 'string' ? args.namespace : ''
        element<HTMLInputElement>('pod').value = typeof args.pod === 'string' ? args.pod : ''
      } catch {
        /* The JSON editor reports invalid input when called. */
      }
    }
  }

  function copyTargetsToArguments(): void {
    if (view !== 'tools') return

    try {
      const args = JSON.parse(element<HTMLTextAreaElement>('arguments').value)

      if (!args || typeof args !== 'object' || Array.isArray(args)) return

      const fields = targetFields()

      for (const [key, visible] of [
        ['namespace', fields.namespace],
        ['pod', fields.pod]
      ] as const) {
        if (!visible) continue

        const value = element<HTMLInputElement>(key).value

        if (value || selectedTool()?.inputSchema.required?.includes(key)) args[key] = value
        else delete args[key]
      }

      element<HTMLTextAreaElement>('arguments').value = JSON.stringify(args, null, 2)
    } catch {
      /* Preserve an unfinished JSON edit. */
    }
  }

  async function prepareTargets(reload = false): Promise<void> {
    const fields = targetFields()

    if (!client || (!fields.namespace && !fields.pod)) return

    const activeGeneration = generation,
      revision = ++pickerRevision
    const activeClient = client
    const current = () => generation === activeGeneration && pickerRevision === revision
    const options = (id: string, names: string[]) =>
      element(id).replaceChildren(
        ...names.map(name => {
          const option = document.createElement('option')

          option.value = name

          return option
        })
      )

    pickerLoading = true
    updateControls()
    element('picker-status').textContent = 'Loading choices…'
    element('pod-options').replaceChildren()
    try {
      if ((!knownNamespaces || reload) && tools.some(tool => tool.name === 'list_accessible_namespaces')) {
        const result = (await activeClient.callTool({
          name: 'list_accessible_namespaces',
          arguments: {}
        })) as CallToolResult

        if (!current()) return

        if (result.isError)
          throw new Error(
            result.content
              .filter(item => item.type === 'text')
              .map(item => item.text)
              .join('\n')
          )

        const names = result.structuredContent?.namespaces

        knownNamespaces = Array.isArray(names)
          ? names
              .filter(
                (name): name is string =>
                  typeof name === 'string' && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(name)
              )
              .sort()
          : []
      }

      if (!current()) return

      options('namespace-options', knownNamespaces ?? [])
      const namespace = element<HTMLInputElement>('namespace')

      if (!namespace.value && fields.requiredNamespace) namespace.value = knownNamespaces?.[0] ?? ''

      copyTargetsToArguments()

      if (fields.pod && namespace.value && tools.some(tool => tool.name === 'list_pods')) {
        const requestedNamespace = namespace.value
        const result = (await activeClient.callTool({
          name: 'list_pods',
          arguments: { namespace: requestedNamespace }
        })) as CallToolResult

        if (!current() || namespace.value !== requestedNamespace) return

        if (result.isError)
          throw new Error(
            result.content
              .filter(item => item.type === 'text')
              .map(item => item.text)
              .join('\n')
          )

        const names = result.structuredContent?.pods
        const pods = Array.isArray(names)
          ? names.filter((name): name is string => typeof name === 'string').sort()
          : []

        options('pod-options', pods)
        const pod = element<HTMLInputElement>('pod')

        if (!pod.value) pod.value = pods[0] ?? ''

        copyTargetsToArguments()
      }

      element('picker-status').textContent = fields.pod
        ? element<HTMLInputElement>('pod').value
          ? 'Choices contain current pods. You can also enter a known pod name for historical analysis.'
          : 'No current pod selected. Choose another namespace or enter a known pod name for historical analysis.'
        : ''
    } catch (error) {
      if (current())
        element('picker-status').textContent =
          'Choices unavailable. You can enter a name. ' +
          (error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) {
        pickerLoading = false
        updateControls()
      }
    }
  }

  function selectTool(): void {
    const selected = tools.find(tool => tool.name === element<HTMLSelectElement>('tool').value)

    renderMarkdown(element('tool-description'), selected?.description ?? '')
    element('schema').textContent = JSON.stringify(selected?.inputSchema ?? {}, null, 2)
    element<HTMLTextAreaElement>('arguments').value = JSON.stringify(
      argumentExample(selected?.inputSchema ?? {}),
      null,
      2
    )
    updateTargetFields()
    void prepareTargets()
  }

  async function run(): Promise<void> {
    if (!client || busy || pickerLoading) return

    if (view === 'workloads') {
      const namespace = element<HTMLInputElement>('namespace').value.trim()

      if (namespace && !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace)) {
        status('Select or enter a valid namespace, or leave it empty for all accessible namespaces.', true)

        return
      }
    }

    if (view === 'podUsage') {
      const namespace = element<HTMLInputElement>('namespace').value.trim()
      const pod = element<HTMLInputElement>('pod').value.trim()

      if (
        !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace) ||
        !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(pod)
      ) {
        status('Select or enter a namespace and a valid pod name before querying.', true)

        return
      }
    }

    const activeGeneration = generation
    const activeView = view
    const usage = view === 'clusterUsage' || view === 'podUsage'
    const historical = usage && element<HTMLInputElement>('usage-history').checked
    const tool =
      (view === 'tools' ? element<HTMLSelectElement>('tool').value : views[view].tool) +
      (historical ? '_history' : '')

    if (!tools.some(item => item.name === tool)) {
      status('This MCP server does not advertise that tool.', true)

      return
    }

    busy = true
    updateControls()
    status('Calling ' + tool + '…')
    try {
      const args: unknown =
        view === 'tools'
          ? JSON.parse(element<HTMLTextAreaElement>('arguments').value)
          : view === 'workloads'
            ? element<HTMLInputElement>('namespace').value.trim()
              ? { namespace: element<HTMLInputElement>('namespace').value.trim() }
              : {}
            : usage
              ? {
                  windowSeconds: Number(element<HTMLSelectElement>('rate-window').value),
                  ...(view === 'podUsage'
                    ? {
                        namespace: element<HTMLInputElement>('namespace').value.trim(),
                        pod: element<HTMLInputElement>('pod').value.trim(),
                        perContainer: element<HTMLInputElement>('usage-breakdown').checked
                      }
                    : { perNode: element<HTMLInputElement>('usage-breakdown').checked }),
                  ...(historical
                    ? { historySeconds: Number(element<HTMLSelectElement>('history-window').value) }
                    : {})
                }
              : {}

      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Arguments must be a JSON object.')

      if (
        view === 'tools' &&
        selectedTool()?.annotations?.destructiveHint &&
        !window.confirm(`Call ${tool}? This changes cluster resources and may interrupt service.`)
      ) {
        status('Action cancelled.')

        return
      }

      const result = (await client.callTool(
        {
          name: tool,
          arguments: args as Record<string, unknown>
        },
        undefined,
        { timeout: historical ? 120000 : 60000 }
      )) as CallToolResult

      if (activeGeneration !== generation || activeView !== view) return

      status(
        result.isError
          ? 'The MCP tool returned an error. See the result below.'
          : 'Result received from ' + tool + '.',
        !!result.isError
      )
      renderResult(result)
    } catch (error) {
      if (activeGeneration === generation && activeView === view)
        status(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (activeGeneration === generation) {
        busy = false
        updateControls()
      }
    }
  }

  async function signIn(): Promise<void> {
    if (busy) return

    const activeGeneration = ++generation

    busy = true
    updateControls()
    status('Complete OpenID sign-in in the popup…')
    try {
      const nonce = crypto.randomUUID()
      const signedIn = await manager.signinPopup({ nonce })

      if (activeGeneration !== generation) {
        userMemory.clear()

        return
      }

      if (!signedIn.access_token || signedIn.expired || !signedIn.expires_at)
        throw new Error('The provider did not return a valid access token with an expiry.')

      if (!signedIn.id_token) throw new Error('The provider did not return an OpenID ID token.')

      const keys = await manager.metadataService.getSigningKeys()
      const { payload } = await jwtVerify(signedIn.id_token, createLocalJWKSet({ keys: keys as JWK[] }), {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat']
      })

      if (
        payload.nonce !== nonce ||
        payload.sub !== signedIn.profile.sub ||
        (payload.azp !== undefined && payload.azp !== config.clientId) ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
      ) {
        throw new Error('The OpenID token does not match this sign-in request.')
      }

      if (payload.at_hash !== undefined) {
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signedIn.access_token))
        )
        const hash = globalThis
          .btoa(String.fromCharCode(...digest.slice(0, digest.length / 2)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '')

        if (payload.at_hash !== hash) throw new Error('The OpenID token does not match the access token.')
      }

      if (activeGeneration !== generation) return

      user = signedIn
      // Do not retain a second copy of the token in the protocol library.
      await manager.removeUser()

      if (activeGeneration !== generation) return

      transport = new StreamableHTTPClientTransport(new URL('/mcp', location.origin), {
        fetch: async (input, init) => {
          if (!user || user.expired) throw new Error('Credentials expired. Sign in again.')

          const headers = new Headers(init?.headers)

          headers.set('authorization', 'Bearer ' + user.access_token)
          const response = await fetch(input, { ...init, headers, credentials: 'omit' })

          if (response.status === 401) void forget('The access token was rejected. Sign in again.')

          return response
        }
      })
      client = new Client(
        { name: 'driftmower-web-explorer', version: '1.0.0' },
        { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
      )
      await client.connect(transport)

      if (activeGeneration !== generation) return

      let cursor: string | undefined

      do {
        const page = await client.listTools(cursor ? { cursor } : {})

        if (activeGeneration !== generation) return

        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor)

      tools.sort((a, b) => a.name.localeCompare(b.name))
      const select = element<HTMLSelectElement>('tool')

      select.replaceChildren(
        ...tools.map(tool => {
          const option = document.createElement('option')

          option.value = tool.name
          option.textContent = tool.name

          return option
        })
      )
      selectTool()
      expiration = setTimeout(
        () => {
          void forget('Credentials expired. Sign in again.')
        },
        Math.max(0, (signedIn.expires_at - Date.now() / 1000) * 1000)
      )
      busy = false
      updateControls()
      await run()
    } catch (error) {
      if (activeGeneration !== generation) return

      const message = error instanceof Error ? error.message : String(error)

      await forget('Sign-in or MCP connection failed. ' + message)
      element('status').dataset.error = 'true'
    } finally {
      if (activeGeneration === generation) {
        busy = false
        updateControls()
      }
    }
  }

  element('signin').addEventListener('click', () => {
    void signIn()
  })
  element('signout').addEventListener('click', () => {
    void forget()
  })
  element('run').addEventListener('click', () => {
    void run()
  })
  element('filter').addEventListener('input', () => {
    if (view === 'workloads') drawWorkloads()
    else drawTable()
  })
  element('tool').addEventListener('change', selectTool)
  element('usage-history').addEventListener('change', () => {
    element('history-window-field').hidden = !element<HTMLInputElement>('usage-history').checked
  })
  element('namespace').addEventListener('change', () => {
    element<HTMLInputElement>('pod').value = ''
    copyTargetsToArguments()
    void prepareTargets()
  })
  element('pod').addEventListener('input', () => {
    copyTargetsToArguments()
    updateControls()
  })
  element('pod').addEventListener('change', copyTargetsToArguments)
  element('reload-targets').addEventListener('click', () => {
    void prepareTargets(true)
  })
  element('arguments').addEventListener('change', () => {
    updateTargetFields()
    void prepareTargets()
  })
  for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
    button.addEventListener('click', async () => {
      view = button.dataset.view as View
      for (const item of document.querySelectorAll('nav button')) item.removeAttribute('aria-current')
      button.setAttribute('aria-current', 'page')
      element('heading').textContent = views[view].title
      renderMarkdown(element('description'), views[view].description)
      pickerRevision++
      pickerLoading = false
      element('tool-editor').hidden = view !== 'tools'
      element('run').textContent = view === 'tools' ? 'Call tool' : 'Refresh'
      element('result').replaceChildren()
      workloadRows = []
      openWorkloadOwners.clear()
      element('raw').hidden = true
      element('filter').hidden = true
      element('count').hidden = true
      element<HTMLInputElement>('filter').value = ''

      element('usage-summary').hidden = true
      element<HTMLInputElement>('usage-history').checked = false
      element('history-window-field').hidden = true
      element<HTMLInputElement>('usage-breakdown').checked = view === 'podUsage'
      element('breakdown-label').textContent =
        view === 'podUsage' ? 'Per-container breakdown' : 'Per-node breakdown'
      updateTargetFields()
      await prepareTargets()

      if (view !== 'tools' && (view !== 'podUsage' || element<HTMLInputElement>('pod').value.trim()))
        void run()
    })
  }

  // Clear memory on navigation, including pages entering the back/forward cache.
  window.addEventListener('pagehide', () => {
    generation++
    clearTimeout(expiration)
    user = null
    client = null
    transport = null
    userMemory.clear()
    stateMemory.clear()
    workloadRows = []
    openWorkloadOwners.clear()
    element('result').replaceChildren()
    element('raw-result').textContent = ''
  })
  updateControls()

  window.addEventListener('pageshow', event => {
    if (event.persisted) location.reload()
  })
}

void main().catch(() =>
  status('MCP Explorer could not start. Check the browser console and server configuration.', true)
)
