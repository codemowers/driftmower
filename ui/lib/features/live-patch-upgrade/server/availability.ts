import "server-only"

import { KubeApiError, kubeApiRequest } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { CLUSTER_FACT_TTL_MS } from "@/lib/features/provisioning/constants"
import { getApiSurface } from "@/lib/features/provisioning/facts/discovery"
import { negotiateVersion } from "@/lib/features/provisioning/api-surface"
import { ADMISSION_GROUP, buildLivePatchUpgradeObjects } from "../manifest"
import type { PolicyVersion } from "../types"
import { DRY_RUN, policyPath } from "./paths"

export type LivePatchUpgradeAvailability = {
  available: boolean
  canWrite: boolean
  version: PolicyVersion | null
}

const POLICY_KIND = "MutatingAdmissionPolicy"
const SUPPORTED_VERSIONS: PolicyVersion[] = ["v1", "v1beta1"]

async function negotiatedVersion(): Promise<PolicyVersion | null> {
  const surface = await getApiSurface()
  const served = negotiateVersion(surface, ADMISSION_GROUP, POLICY_KIND, SUPPORTED_VERSIONS)
  return served ? (served.version as PolicyVersion) : null
}

async function probeWrite(version: PolicyVersion): Promise<boolean> {
  const { policy } = buildLivePatchUpgradeObjects({
    key: "probe",
    hash: "probe",
    namespace: "default",
    sourceImage: "probe:source",
    targetImage: "probe:target",
    policyVersion: version,
    workload: { kind: "Deployment", name: "probe", uid: "probe" },
    podSelector: null,
  })
  try {
    await kubeApiRequest("POST", `${policyPath(version)}${DRY_RUN}`, { body: policy })
    return true
  } catch (e) {
    if (e instanceof KubeApiError && e.status >= 400 && e.status < 500) {
      console.warn(`[live-patch-upgrade] write probe rejected (${e.status}); temporary fixes are copy-only until it passes`)
      return false
    }
    throw e
  }
}

async function loadAvailability(): Promise<LivePatchUpgradeAvailability> {
  const version = await negotiatedVersion()
  if (!version) return { available: false, canWrite: false, version: null }
  return { available: true, canWrite: await probeWrite(version), version }
}

export const getLivePatchUpgradeAvailability = createTtlCache(CLUSTER_FACT_TTL_MS, loadAvailability)
