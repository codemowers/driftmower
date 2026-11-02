// A one-shot query param platform-manager appends when it hands a user over
// after creating something the newest report cannot possibly contain. Read and
// stripped by ClusterInit; it is never written back into a URL.
export const REFRESH_PARAM = "refresh"

export const SESSION_ENDED_HEADER = "x-session-ended"

export const ANALYZE_CLUSTER_URL = "/api/analyze-cluster"
export const KUBERNETES_CONTEXTS_URL = "/api/kubernetes-contexts"
export const REPORTS_URL = "/api/reports"
export const IMAGE_USAGE_CHANGES_URL = "/api/image-usage-changes"
export const VULNERABILITY_REPORT_URL = "/api/vulnerability-report"
export const WORKLOADS_URL = "/api/workloads"
export const CLUSTER_RESOURCES_URL = "/api/cluster-resources"
export const CLUSTER_NODES_URL = "/api/cluster-resources/nodes"
export const LIVE_PATCH_UPGRADE_URL = "/api/live-patch-upgrade"
export const LIVE_PATCH_UPGRADE_PREVIEW_URL = "/api/live-patch-upgrade/preview"
export const LIVE_PATCH_UPGRADE_APPLY_URL = "/api/live-patch-upgrade/apply"
export const LIVE_PATCH_UPGRADE_REMOVE_URL = "/api/live-patch-upgrade/remove"
export const NETSTATD_STREAM_URL = "/api/netstatd/stream"
export const HELM_RELEASES_URL = "/api/helm-releases"
export const LOGS_URL = "/api/logs"
export const LOGS_CONTAINERS_URL = "/api/logs/containers"
export const ACTIONS_ASSESS_URL = "/api/llm/actions/assess"
export const POD_DIAGNOSIS_URL = "/api/llm/pod-diagnosis"
