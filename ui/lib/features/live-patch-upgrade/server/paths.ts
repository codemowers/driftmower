import "server-only"

import { ADMISSION_GROUP, LIVE_PATCH_UPGRADE_LABEL } from "../manifest"
import type { PolicyVersion } from "../types"

export const LABEL_SELECTOR = encodeURIComponent(`${LIVE_PATCH_UPGRADE_LABEL}=true`)
export const DRY_RUN = "?dryRun=All"

const WORKLOAD_PLURALS: Record<string, string> = {
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
}

export function policyPath(version: PolicyVersion, name?: string): string {
  return `/apis/${ADMISSION_GROUP}/${version}/mutatingadmissionpolicies${name ? `/${name}` : ""}`
}

export function bindingPath(version: PolicyVersion, name?: string): string {
  return `/apis/${ADMISSION_GROUP}/${version}/mutatingadmissionpolicybindings${name ? `/${name}` : ""}`
}

export function workloadPath(kind: string, namespace: string, name: string): string | null {
  const plural = WORKLOAD_PLURALS[kind]
  if (!plural) return null
  return `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/${plural}/${encodeURIComponent(name)}`
}

export function podCollectionPath(namespace: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
}

export function podPath(namespace: string, name: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`
}
