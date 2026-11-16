export type Drift =
  | "up_to_date"
  | "patch_behind"
  | "minor_behind"
  | "major_behind"
  | "ahead"
  | "no_data"
  | "no_version"

export type Artifact = {
  id: string
  registry: string
  repository: string
  tag: string
  digest: string
  sizeBytes: number
  workload: string
  namespace: string
  signed: boolean
  sbom: boolean
  drift: Drift
  criticalCves?: number
}

export type ArtifactGroup = {
  key: string
  label: string
  kind: "helm" | "namespace"
  meta: string
  artifacts: Artifact[]
}

export type SandboxStatus = "ready" | "provisioning" | "expired"

export type Sandbox = {
  id: string
  name: string
  status: SandboxStatus
  k8sVersion: string
  ttl: string
}

const GB = 1_000_000_000
const MB = 1_000_000

export function formatSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  return `${Math.round(bytes / MB)} MB`
}

export const CLUSTER_NAME = "alpha"
export const BUNDLE_DATE = "2026-05-31"
export const BUNDLE_BASENAME = `driftmower-${CLUSTER_NAME}-${BUNDLE_DATE}`
export const MANIFEST_COUNT = 156
export const BUNDLE_FILENAME = `${BUNDLE_BASENAME}.tar.zst`

export const ARTIFACT_GROUPS: ArtifactGroup[] = [
  {
    key: "cilium",
    label: "cilium",
    kind: "helm",
    meta: "Helm release · kube-system",
    artifacts: [
      { id: "cilium", registry: "quay.io", repository: "cilium/cilium", tag: "v1.18.7", digest: "99b029a0a7c2", sizeBytes: 487 * MB, workload: "cilium", namespace: "kube-system", signed: true, sbom: true, drift: "minor_behind" },
      { id: "cilium-operator", registry: "quay.io", repository: "cilium/operator-generic", tag: "v1.18.7", digest: "244306c5e7c6", sizeBytes: 118 * MB, workload: "cilium-operator", namespace: "kube-system", signed: true, sbom: true, drift: "minor_behind" },
      { id: "hubble-relay", registry: "quay.io", repository: "cilium/hubble-relay", tag: "v1.18.7", digest: "9bb9b2b1a4f4", sizeBytes: 74 * MB, workload: "hubble-relay", namespace: "kube-system", signed: true, sbom: true, drift: "minor_behind" },
      { id: "hubble-ui", registry: "quay.io", repository: "cilium/hubble-ui", tag: "v0.13.3", digest: "661d5de70501", sizeBytes: 42 * MB, workload: "hubble-ui", namespace: "kube-system", signed: true, sbom: true, drift: "patch_behind" },
      { id: "hubble-ui-backend", registry: "quay.io", repository: "cilium/hubble-ui-backend", tag: "v0.13.3", digest: "db1454e45dc3", sizeBytes: 58 * MB, workload: "hubble-ui", namespace: "kube-system", signed: true, sbom: true, drift: "patch_behind" },
    ],
  },
  {
    key: "cert-manager",
    label: "cert-manager",
    kind: "helm",
    meta: "Helm release · cert-manager",
    artifacts: [
      { id: "cm-controller", registry: "quay.io", repository: "jetstack/cert-manager-controller", tag: "v1.20.0", digest: "b9009aa6b45b", sizeBytes: 158 * MB, workload: "cert-manager", namespace: "cert-manager", signed: true, sbom: true, drift: "patch_behind" },
      { id: "cm-cainjector", registry: "quay.io", repository: "jetstack/cert-manager-cainjector", tag: "v1.20.0", digest: "6a620381d995", sizeBytes: 149 * MB, workload: "cert-manager-cainjector", namespace: "cert-manager", signed: true, sbom: true, drift: "patch_behind" },
      { id: "cm-webhook", registry: "quay.io", repository: "jetstack/cert-manager-webhook", tag: "v1.20.0", digest: "2133daae1f08", sizeBytes: 142 * MB, workload: "cert-manager-webhook", namespace: "cert-manager", signed: true, sbom: true, drift: "patch_behind" },
    ],
  },
  {
    key: "cert-manager-csi-driver",
    label: "cert-manager-csi-driver",
    kind: "helm",
    meta: "Helm release · cert-manager",
    artifacts: [
      { id: "csi-driver", registry: "quay.io", repository: "jetstack/cert-manager-csi-driver", tag: "v0.13.0", digest: "07982a9d5b0b", sizeBytes: 71 * MB, workload: "cert-manager-csi-driver", namespace: "cert-manager", signed: true, sbom: true, drift: "minor_behind" },
      { id: "csi-node-driver-registrar", registry: "quay.io", repository: "jetstack/csi-node-driver-registrar", tag: "v2.16.0", digest: "ab482308a492", sizeBytes: 25 * MB, workload: "cert-manager-csi-driver", namespace: "cert-manager", signed: true, sbom: true, drift: "up_to_date" },
      { id: "livenessprobe", registry: "quay.io", repository: "jetstack/livenessprobe", tag: "v2.18.0", digest: "c4cc074199c0", sizeBytes: 20 * MB, workload: "cert-manager-csi-driver", namespace: "cert-manager", signed: true, sbom: true, drift: "up_to_date" },
    ],
  },
  {
    key: "monitoring",
    label: "monitoring",
    kind: "namespace",
    meta: "Namespace · monitoring",
    artifacts: [
      { id: "prometheus", registry: "quay.io", repository: "prometheus/prometheus", tag: "v3.10.0", digest: "7571a304e67f", sizeBytes: 261 * MB, workload: "prometheus", namespace: "monitoring", signed: true, sbom: true, drift: "minor_behind" },
      { id: "thanos", registry: "quay.io", repository: "thanos/thanos", tag: "v0.41.0", digest: "cf3e9b292e43", sizeBytes: 178 * MB, workload: "prometheus", namespace: "monitoring", signed: true, sbom: true, drift: "up_to_date" },
      { id: "alertmanager", registry: "quay.io", repository: "prometheus/alertmanager", tag: "v0.31.1", digest: "88b605de9aba", sizeBytes: 98 * MB, workload: "alertmanager", namespace: "monitoring", signed: true, sbom: true, drift: "minor_behind" },
      { id: "blackbox-exporter", registry: "quay.io", repository: "prometheus/blackbox-exporter", tag: "v0.25.0", digest: "b04a9fef4fa0", sizeBytes: 34 * MB, workload: "blackbox-exporter", namespace: "monitoring", signed: true, sbom: true, drift: "minor_behind" },
      { id: "node-exporter", registry: "mirror.gcr.io", repository: "prom/node-exporter", tag: "v1.10.2", digest: "3ac34ce007ac", sizeBytes: 27 * MB, workload: "node-exporter", namespace: "monitoring", signed: true, sbom: true, drift: "minor_behind" },
    ],
  },
  {
    key: "loki",
    label: "loki",
    kind: "helm",
    meta: "Helm release · monitoring",
    artifacts: [
      { id: "loki", registry: "docker.io", repository: "grafana/loki", tag: "3.6.7", digest: "3c8fd3570dd9", sizeBytes: 138 * MB, workload: "loki", namespace: "monitoring", signed: true, sbom: true, drift: "minor_behind" },
      { id: "k8s-sidecar", registry: "docker.io", repository: "kiwigrid/k8s-sidecar", tag: "2.5.0", digest: "a6b3f707f883", sizeBytes: 86 * MB, workload: "loki", namespace: "monitoring", signed: true, sbom: true, drift: "minor_behind" },
    ],
  },
  {
    key: "prometheus-operator",
    label: "prometheus-operator",
    kind: "helm",
    meta: "Helm release · prometheus-operator",
    artifacts: [
      { id: "prometheus-operator", registry: "quay.io", repository: "prometheus-operator/prometheus-operator", tag: "v0.90.1", digest: "52a6a92d915e", sizeBytes: 106 * MB, workload: "prometheus-operator-kube-p-operator", namespace: "prometheus-operator", signed: true, sbom: true, drift: "minor_behind" },
      { id: "kube-state-metrics", registry: "registry.k8s.io", repository: "kube-state-metrics/kube-state-metrics", tag: "v2.18.0", digest: "1545919b72e3", sizeBytes: 88 * MB, workload: "prometheus-operator-kube-state-metrics", namespace: "prometheus-operator", signed: true, sbom: true, drift: "minor_behind" },
    ],
  },
  {
    key: "kyverno",
    label: "kyverno",
    kind: "helm",
    meta: "Helm release · kyverno",
    artifacts: [
      { id: "kyverno", registry: "reg.kyverno.io", repository: "kyverno/kyverno", tag: "v1.18.1", digest: "dcd8cf6de215", sizeBytes: 122 * MB, workload: "kyverno-admission-controller", namespace: "kyverno", signed: true, sbom: true, drift: "ahead" },
      { id: "kyverno-background", registry: "reg.kyverno.io", repository: "kyverno/background-controller", tag: "v1.18.1", digest: "33a19d2ae18e", sizeBytes: 118 * MB, workload: "kyverno-background-controller", namespace: "kyverno", signed: true, sbom: true, drift: "up_to_date" },
      { id: "kyverno-cleanup", registry: "reg.kyverno.io", repository: "kyverno/cleanup-controller", tag: "v1.18.1", digest: "e9b3342264c8", sizeBytes: 116 * MB, workload: "kyverno-cleanup-controller", namespace: "kyverno", signed: true, sbom: true, drift: "ahead" },
      { id: "kyverno-reports", registry: "reg.kyverno.io", repository: "kyverno/reports-controller", tag: "v1.18.1", digest: "4972c80bccba", sizeBytes: 120 * MB, workload: "kyverno-reports-controller", namespace: "kyverno", signed: true, sbom: true, drift: "up_to_date" },
    ],
  },
  {
    key: "cnpg",
    label: "cnpg",
    kind: "helm",
    meta: "Helm release · cnpg-system",
    artifacts: [
      { id: "cloudnative-pg", registry: "ghcr.io", repository: "cloudnative-pg/cloudnative-pg", tag: "1.29.0", digest: "68074486205a", sizeBytes: 187 * MB, workload: "cnpg-cloudnative-pg", namespace: "cnpg-system", signed: true, sbom: true, drift: "patch_behind" },
      { id: "plugin-barman-cloud", registry: "ghcr.io", repository: "cloudnative-pg/plugin-barman-cloud", tag: "v0.12.0", digest: "0b9c42812331", sizeBytes: 96 * MB, workload: "cnpg-plugin-barman-cloud", namespace: "cnpg-system", signed: true, sbom: true, drift: "up_to_date" },
    ],
  },
  {
    key: "memelord-laurivosandi",
    label: "memelord-laurivosandi",
    kind: "namespace",
    meta: "Namespace · memelord-laurivosandi",
    artifacts: [
      { id: "memelord-db", registry: "ghcr.io", repository: "cloudnative-pg/postgresql", tag: "17", digest: "ae81813008a9", sizeBytes: 398 * MB, workload: "memelord-memelord-laurivosandi-database", namespace: "memelord-laurivosandi", signed: true, sbom: true, drift: "no_data", criticalCves: 3 },
      { id: "memelord-redis", registry: "docker.dragonflydb.io", repository: "dragonflydb/dragonfly", tag: "v1.37.0", digest: "84b1009aee0b", sizeBytes: 164 * MB, workload: "memelord-memelord-laurivosandi-redis", namespace: "memelord-laurivosandi", signed: true, sbom: true, drift: "minor_behind" },
      { id: "memelord-app", registry: "docker.io", repository: "codemowers/memelord", tag: "latest", digest: "69b792bc4031", sizeBytes: 212 * MB, workload: "memelord-memelord-laurivosandi-app", namespace: "memelord-laurivosandi", signed: false, sbom: false, drift: "no_version" },
    ],
  },
  {
    key: "dragonfly-operator",
    label: "dragonfly-operator",
    kind: "helm",
    meta: "Helm release · dragonfly-operator-system",
    artifacts: [
      { id: "dragonfly-operator", registry: "docker.dragonflydb.io", repository: "dragonflydb/operator", tag: "v1.5.0", digest: "2ceb0128302c", sizeBytes: 78 * MB, workload: "dragonfly-operator", namespace: "dragonfly-operator-system", signed: true, sbom: true, drift: "up_to_date" },
      { id: "kube-rbac-proxy", registry: "quay.io", repository: "brancz/kube-rbac-proxy", tag: "v0.20.2", digest: "ad0fa9f0adc9", sizeBytes: 31 * MB, workload: "dragonfly-operator", namespace: "dragonfly-operator-system", signed: true, sbom: true, drift: "minor_behind" },
    ],
  },
  {
    key: "driftmowers",
    label: "driftmower",
    kind: "namespace",
    meta: "Namespace · driftmowers",
    artifacts: [
      { id: "driftmower-be", registry: "docker.io", repository: "codemowers/driftmower-be", tag: "0.13.0", digest: "df9d7a718197", sizeBytes: 231 * MB, workload: "driftmower-be", namespace: "driftmowers", signed: true, sbom: true, drift: "patch_behind" },
      { id: "registry-scraper", registry: "docker.io", repository: "codemowers/registry-scraper", tag: "2.2.0", digest: "1cfdf397227b", sizeBytes: 143 * MB, workload: "registry-scraper", namespace: "driftmowers", signed: true, sbom: true, drift: "ahead" },
      { id: "driftmower-ui", registry: "docker.io", repository: "codemowers/driftmower-ui", tag: "latest", digest: "d58c4851277c", sizeBytes: 176 * MB, workload: "driftmower-ui", namespace: "driftmowers", signed: false, sbom: false, drift: "no_version" },
      { id: "driftmower-explorer", registry: "docker.io", repository: "codemowers/driftmower-explorer", tag: "latest", digest: "48e35c371d22", sizeBytes: 128 * MB, workload: "driftmower-explorer", namespace: "driftmowers", signed: false, sbom: false, drift: "no_version" },
      { id: "netstatd", registry: "docker.io", repository: "codemowers/netstatd", tag: "latest", digest: "eba6a43b559f", sizeBytes: 44 * MB, workload: "netstatd", namespace: "driftmowers", signed: false, sbom: false, drift: "no_version" },
    ],
  },
  {
    key: "passmower",
    label: "passmower",
    kind: "helm",
    meta: "Helm release · passmower",
    artifacts: [
      { id: "passmower", registry: "ghcr.io", repository: "passmower/passmower", tag: "1.2.0-dev", digest: "d22a18a2bc09", sizeBytes: 132 * MB, workload: "passmower", namespace: "passmower", signed: true, sbom: true, drift: "up_to_date" },
      { id: "passmower-redis", registry: "docker.io", repository: "library/redis", tag: "latest", digest: "25dbb04fc4d6", sizeBytes: 117 * MB, workload: "redis", namespace: "passmower", signed: false, sbom: false, drift: "no_version" },
      { id: "whoami", registry: "docker.io", repository: "traefik/whoami", tag: "v1.11.0", digest: "200689790a0a", sizeBytes: 8 * MB, workload: "whoami", namespace: "passmower", signed: true, sbom: true, drift: "up_to_date" },
    ],
  },
  {
    key: "trivy-operator",
    label: "trivy-operator",
    kind: "helm",
    meta: "Helm release · kube-system",
    artifacts: [
      { id: "trivy-operator", registry: "mirror.gcr.io", repository: "aquasec/trivy-operator", tag: "0.30.1", digest: "448484ece65e", sizeBytes: 181 * MB, workload: "trivy-operator", namespace: "kube-system", signed: true, sbom: true, drift: "up_to_date" },
      { id: "trivy-ui", registry: "docker.io", repository: "locustbaby/trivy-ui", tag: "v0.0.3", digest: "2637d075b4ac", sizeBytes: 63 * MB, workload: "trivy-ui", namespace: "kube-system", signed: true, sbom: true, drift: "minor_behind" },
    ],
  },
  {
    key: "redpanda",
    label: "redpanda-operator",
    kind: "helm",
    meta: "Helm release · redpanda",
    artifacts: [
      { id: "redpanda-operator", registry: "docker.redpanda.com", repository: "redpandadata/redpanda-operator", tag: "v25.3.2", digest: "10514e3d558f", sizeBytes: 254 * MB, workload: "redpanda-operator", namespace: "redpanda", signed: true, sbom: true, drift: "major_behind", criticalCves: 5 },
    ],
  },
  {
    key: "llm",
    label: "llm",
    kind: "namespace",
    meta: "Namespace · llm",
    artifacts: [
      { id: "open-webui", registry: "ghcr.io", repository: "open-webui/open-webui", tag: "v0.9.5", digest: "e045bde3b004", sizeBytes: 1.8 * GB, workload: "webui", namespace: "llm", signed: true, sbom: true, drift: "ahead" },
      { id: "llama-cpp", registry: "ghcr.io", repository: "ggml-org/llama.cpp", tag: "server-vulkan-b9102", digest: "344da4e781c7", sizeBytes: 2.4 * GB, workload: "llama", namespace: "llm", signed: false, sbom: false, drift: "no_version" },
      { id: "prometheus-mcp-server", registry: "ghcr.io", repository: "pab1it0/prometheus-mcp-server", tag: "1.6.1", digest: "ed91f3f9e4f6", sizeBytes: 91 * MB, workload: "prometheus-mcp-server", namespace: "llm", signed: true, sbom: true, drift: "up_to_date" },
    ],
  },
]

export type ArtifactClass = "platform" | "application"
export type ClassifiedArtifact = Artifact & { category: ArtifactClass }

const APPLICATION_GROUP_KEYS = new Set(["memelord-laurivosandi", "driftmowers", "passmower", "llm"])

export const ALL_ARTIFACTS: ClassifiedArtifact[] = ARTIFACT_GROUPS.flatMap(group => {
  const category: ArtifactClass = APPLICATION_GROUP_KEYS.has(group.key) ? "application" : "platform"
  return group.artifacts.map(a => ({ ...a, category }))
})

export const ARTIFACT_CLASSES: { id: ArtifactClass; label: string }[] = [
  { id: "platform", label: "Kubernetes platform components" },
  { id: "application", label: "Application images" },
]

export const SANDBOXES: Sandbox[] = [
  { id: "sb-1", name: "alpha-preflight", status: "ready", k8sVersion: "v1.31.1", ttl: "3h 41m" },
  { id: "sb-2", name: "client-acme-handoff", status: "provisioning", k8sVersion: "v1.30.4", ttl: "4h 00m" },
  { id: "sb-3", name: "airgap-restore-check", status: "ready", k8sVersion: "v1.31.1", ttl: "1h 12m" },
  { id: "sb-4", name: "cilium-1.19-preview", status: "provisioning", k8sVersion: "v1.31.1", ttl: "4h 00m" },
  { id: "sb-5", name: "postgres-upgrade-test", status: "expired", k8sVersion: "v1.29.7", ttl: "expired" },
]
