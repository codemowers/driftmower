import type { OperatorHealth } from '../../domain/provisioning/availability.js'
import type { Fact } from '../../domain/provisioning/types.js'
import { collect } from '../kubernetes-list.js'
import type { KubernetesReader } from '../observability-kubernetes.js'
import { optional } from './tolerate.js'

export type RawDeployment = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string; args?: string[] }[] } } }
  status?: { readyReplicas?: number }
}

export interface OperatorRef {
  deployment: string
  labels?: Record<string, string>
}

const VERSION_LABELS = ['app.kubernetes.io/version', 'helm.sh/chart']

function versionOf(deployment: RawDeployment): string | null {
  for (const label of VERSION_LABELS) {
    const value = deployment.metadata?.labels?.[label]

    if (value) return value
  }

  // Fall back to the image tag, which is what a user would read off the pod.
  const image = deployment.spec?.template?.spec?.containers?.[0]?.image
  const tag = image?.split('@')[0].split(':')[1]

  return tag ?? null
}

// Several operators take a watch scope as a flag; reporting it stops us from
// promising an operator will act on a namespace it is not watching.
function watchedNamespacesOf(deployment: RawDeployment): string[] | 'all' {
  const args = deployment.spec?.template?.spec?.containers?.[0]?.args ?? []

  for (const arg of args) {
    const match = /^--(?:watch-namespaces?|namespaces?)=(.*)$/.exec(arg)

    if (!match) continue

    const value = match[1].trim()

    if (value === '' || value === '*') return 'all'

    return value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  }

  return 'all'
}

export function loadOperatorDeployments(read: KubernetesReader): Promise<Fact<RawDeployment[]>> {
  return optional('deployments', () =>
    collect(read, '/apis/apps/v1/deployments', item => item as RawDeployment, {
      limit: 200,
      maxPages: 100,
      what: 'Deployment listing'
    })
  )
}

// Where the controller runs is not assumed: a chart may install an operator
// into any namespace. A Deployment matches by exact name, by name prefix (Helm
// prepends the release name) or by carrying every one of the ref's labels.
export function operatorHealthLookup(items: RawDeployment[]): (ref: OperatorRef) => OperatorHealth | null {
  return ref => {
    const match = items.find(deployment => {
      const name = deployment.metadata?.name ?? ''
      const labels = deployment.metadata?.labels ?? {}
      const byLabels =
        ref.labels !== undefined &&
        Object.keys(ref.labels).length > 0 &&
        Object.entries(ref.labels).every(([key, value]) => labels[key] === value)

      return name === ref.deployment || name.startsWith(`${ref.deployment}-`) || byLabels
    })

    if (!match?.metadata?.name) return null

    return {
      deployment: match.metadata.name,
      namespace: match.metadata.namespace ?? '(unknown)',
      readyReplicas: match.status?.readyReplicas ?? 0,
      desiredReplicas: match.spec?.replicas ?? 1,
      version: versionOf(match),
      watchedNamespaces: watchedNamespacesOf(match)
    }
  }
}
