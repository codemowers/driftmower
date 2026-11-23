import type { NodeDrift } from "./types.ts"

// Node conditions are extensible and True does not always mean unhealthy
// (for example, K3s reports EtcdIsVoter). Only known adverse states affect color.
const WARNING_STATES = new Set([
  "SchedulingDisabled", "MemoryPressure", "DiskPressure", "PIDPressure",
  "NetworkUnavailable", "OutOfDisk",
])

export function nodeState(node: Pick<NodeDrift, "readiness" | "schedulable" | "pressure" | "conditions">) {
  const extra = [...new Set([
    !node.schedulable && "SchedulingDisabled",
    node.pressure.memory && "MemoryPressure",
    node.pressure.disk && "DiskPressure",
    node.pressure.pid && "PIDPressure",
    ...(node.conditions ?? []),
  ].filter((condition): condition is string => Boolean(condition)))]
  const border = node.readiness === "NotReady" ? "border-l-status-major"
    : node.readiness !== "Ready" ? "border-l-gray-300"
    : extra.some(condition => WARNING_STATES.has(condition)) ? "border-l-status-patch" : "border-l-status-ok"
  const states = [node.readiness, ...extra].map(label => ({
    label,
    className: label === "NotReady" ? "text-status-major-label"
      : label === "Ready" ? "text-status-ok-label"
      : WARNING_STATES.has(label) ? "text-status-patch-label" : "text-muted-foreground",
  }))
  return { border, label: states.map(state => state.label).join(", "), states }
}
