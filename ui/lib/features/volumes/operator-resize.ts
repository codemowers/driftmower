import { kubectlCommand, kubectlResource, type KubeconfigConnection } from "../../kubernetes/contexts.ts"
import { shellQuote } from "../../utils/shell.ts"
import { expandedStorage, parseQuantity } from "./quantity.ts"
import type { Claim } from "./types.ts"

// Operator-managed workloads declare their volume size in the custom
// resource; patching the PVCs directly is reverted or leaves the template
// behind. Each adapter names the CR field and which claims it sizes.
type Role = { label: string; claims: (claim: Claim, pods: Set<string>) => boolean; patch: (size: string) => unknown }
type Adapter = { group: string; kind: string; roles: Role[] }

const mountedBy = (claim: Claim, pods: Set<string>) => claim.usedBy.some(p => pods.has(p.name))

export const OPERATOR_RESIZE: Adapter[] = [
  {
    group: "postgresql.cnpg.io", kind: "Cluster", roles: [
      // CNPG names the data PVC after the instance Pod and the WAL PVC <pod>-wal.
      { label: "data", claims: (c, pods) => mountedBy(c, pods) && !c.name.endsWith("-wal") && !c.name.includes("-tbs-"), patch: size => ({ spec: { storage: { size } } }) },
      { label: "WAL", claims: (c, pods) => mountedBy(c, pods) && c.name.endsWith("-wal"), patch: size => ({ spec: { walStorage: { size } } }) },
    ],
  },
  {
    group: "cluster.redpanda.com", kind: "Redpanda", roles: [
      { label: "data", claims: mountedBy, patch: size => ({ spec: { clusterSpec: { storage: { persistentVolume: { size } } } } }) },
    ],
  },
  {
    group: "dragonflydb.io", kind: "Dragonfly", roles: [
      { label: "snapshot", claims: mountedBy, patch: size => ({ spec: { snapshot: { persistentVolumeClaimSpec: { resources: { requests: { storage: size } } } } } }) },
    ],
  },
  {
    group: "rabbitmq.com", kind: "RabbitmqCluster", roles: [
      { label: "data", claims: mountedBy, patch: size => ({ spec: { persistence: { storage: size } } }) },
    ],
  },
]

export type OperatorResize = { label: string; current: string; expandable: boolean; steps: { percent: number; size: string; command: string }[] }

export function operatorResizeAdapter(kind: string, apiVersion?: string): Adapter | undefined {
  const group = apiVersion?.includes("/") ? apiVersion.split("/")[0] : apiVersion
  return OPERATOR_RESIZE.find(a => a.kind === kind && a.group === group)
}

// +20/50/100% merge patches of the custom resource, from the largest current
// claim of each role. Sizes are absolute so repeating a command does not
// compound growth.
export function operatorResizeCommands(resource: { kind: string; apiVersion?: string; namespace: string; name: string }, pods: string[], claims: Claim[], connection?: KubeconfigConnection): OperatorResize[] {
  const adapter = operatorResizeAdapter(resource.kind, resource.apiVersion)
  if (!adapter) return []
  const podSet = new Set(pods)
  const target = `${kubectlResource(resource.kind, resource.apiVersion)} ${shellQuote(resource.name)}`
  return adapter.roles.flatMap(role => {
    const matched = claims.filter(c => role.claims(c, podSet))
    if (!matched.length) return []
    const size = (c: Claim) => Math.max(parseQuantity(c.requestedStorage) ?? 0, parseQuantity(c.provisionedStorage) ?? 0)
    const largest = matched.reduce((a, b) => size(b) > size(a) ? b : a)
    const current = largest.requestedStorage ?? largest.provisionedStorage
    if (!current) return []
    const steps = [20, 50, 100].flatMap(percent => {
      const next = expandedStorage(current, percent)
      if (!next) return []
      return [{ percent, size: next, command: `${kubectlCommand("patch", connection, resource.namespace)} ${target} --type=merge -p ${shellQuote(JSON.stringify(role.patch(next)))}` }]
    })
    return [{ label: role.label, current, expandable: matched.every(c => c.canExpand), steps }]
  })
}
