import type { LivePatchUpgradeTarget } from "./types.ts";

export const APPS_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"])

export function restartCommand(target: LivePatchUpgradeTarget): string {
  if (APPS_KINDS.has(target.kind)) {
    return `kubectl rollout restart ${target.kind.toLowerCase()}/${target.name} -n ${target.namespace}`
  }
  return `kubectl delete pods -n ${target.namespace} -l <pod selector of ${target.kind} ${target.name}>`
}
