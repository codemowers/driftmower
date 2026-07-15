import { isInCluster, kubeApiGet } from "../k8s"
import { detectDistro, resolveReference, type Distro } from "./k8s-versions"
import { classifySupport, detectProvider, fetchEolReleases } from "./eol"
import type { ClusterNodesResponse, NodeDrift } from "./types"

type RawNode = {
  metadata: { name: string; creationTimestamp?: string; labels?: Record<string, string> }
  spec?: { unschedulable?: boolean }
  status?: {
    conditions?: { type: string; status: string }[]
    nodeInfo?: { kubeletVersion?: string }
  }
}
type NodeList = { items: RawNode[] }

const ROLE_LABEL_PREFIX = "node-role.kubernetes.io/"

function roleOf(labels: Record<string, string> | undefined): string {
  const roles = Object.keys(labels ?? {})
    .filter(key => key.startsWith(ROLE_LABEL_PREFIX))
    .map(key => key.slice(ROLE_LABEL_PREFIX.length))
    .filter(Boolean)
    .sort()
  return roles.length ? roles.join(",") : "worker"
}

function readinessOf(node: RawNode): "Ready" | "NotReady" | "Unknown" {
  const ready = node.status?.conditions?.find(c => c.type === "Ready")
  if (!ready) return "Unknown"
  if (ready.status === "True") return "Ready"
  if (ready.status === "False") return "NotReady"
  return "Unknown"
}

function envDistro(): Distro | null {
  const value = process.env.K8S_DISTRO
  return value === "k3s" || value === "rke2" || value === "vanilla" ? value : null
}

function nodeLoadError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  if (message.includes("403")) {
    return "Not authorized to list nodes (403). The driftmower-ui ServiceAccount needs get/list on nodes — add a cluster-scoped RBAC rule (see k8s/rbac.yaml) and redeploy."
  }
  return `Could not load nodes from the Kubernetes API: ${message}`
}

export async function getClusterNodes(): Promise<ClusterNodesResponse> {
  if (!isInCluster()) {
    return {
      nodes: [],
      reference: await resolveReference(envDistro() ?? "vanilla"),
      provider: "Kubernetes",
      eolProduct: "kubernetes",
    }
  }

  let items: RawNode[] | null = null
  let error: string | undefined
  try {
    items = (await kubeApiGet<NodeList>("/api/v1/nodes")).items ?? []
  } catch (e) {
    error = nodeLoadError(e)
  }

  // Resolve the reference independently of the node listing so the header survives a
  // node-list failure (e.g. RBAC 403). Distro/provider come from the nodes when available.
  const firstVersion = items?.find(n => n.status?.nodeInfo?.kubeletVersion)?.status?.nodeInfo?.kubeletVersion ?? ""
  const reference = await resolveReference(envDistro() ?? detectDistro(firstVersion))
  const provider = detectProvider(firstVersion)

  if (!items) return { nodes: [], reference, provider: provider.name, eolProduct: provider.eolProduct, error }

  const releases = await fetchEolReleases(provider.eolProduct)

  const nodes: NodeDrift[] = items.map(node => {
    const version = node.status?.nodeInfo?.kubeletVersion ?? ""
    return {
      name: node.metadata.name,
      role: roleOf(node.metadata.labels),
      readiness: readinessOf(node),
      schedulable: !(node.spec?.unschedulable ?? false),
      version,
      creationTimestamp: node.metadata.creationTimestamp ?? null,
      support: classifySupport(version, releases),
    }
  })

  return { nodes, reference, provider: provider.name, eolProduct: provider.eolProduct }
}
