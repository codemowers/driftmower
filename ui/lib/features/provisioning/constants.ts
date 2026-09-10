import type { PresetId, Purpose, WizardStep } from "./types"

export const CAPABILITIES_URL = "/api/provisioning/capabilities"
export const PLAN_URL = "/api/provisioning/plan"
export const INSTANCES_URL = "/api/provisioning/instances"

// The detail page is reachable before the object exists, so it polls until the
// operator creates it. Matches the cadence in use-workload-metrics.ts.
export const POLL_INTERVAL = 10_000
// Long enough that dragging a size field doesn't replan on every keystroke.
export const PLAN_DEBOUNCE_MS = 250

// Cluster-wide facts change only when an operator is installed.
export const CLUSTER_FACT_TTL_MS = 300_000
export const TOPOLOGY_TTL_MS = 60_000
export const OPERATOR_TTL_MS = 30_000

export const STEPS: WizardStep[] = ["offering", "where", "size", "options", "review", "apply"]

export const STEP_LABEL: Record<WizardStep, string> = {
  offering: "What you need",
  where: "Where it goes",
  size: "How big",
  options: "Options",
  review: "Review",
  apply: "Apply",
}

export const PRESET_LABEL: Record<PresetId, string> = {
  dev: "Dev",
  small: "Small",
  ha: "Highly available",
}

export const PURPOSE_LABEL: Record<Purpose, string> = {
  relational: "Relational database",
  cache: "Cache",
  document: "Document database",
  queue: "Message queue",
  stream: "Event stream",
  search: "Search",
  mqtt: "MQTT broker",
  "object-store": "Object storage",
}
