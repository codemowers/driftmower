import "server-only"

import { KubeApiError, kubeApiRequest } from "@/lib/server/k8s"
import type { ManifestInput } from "../manifest"
import { DRY_RUN, podCollectionPath } from "./paths"

const POLL_INTERVAL_MS = 500
const POLL_TIMEOUT_MS = 15_000

type AdmittedPod = { spec?: { containers?: { image?: string }[] } }

async function admittedImage(input: ManifestInput): Promise<string> {
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { generateName: "driftmower-livepatch-probe-", namespace: input.namespace, labels: input.podSelector ?? {} },
    spec: {
      restartPolicy: "Never",
      securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{
        name: "probe",
        image: input.sourceImage,
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      }],
    },
  }
  try {
    const admitted = await kubeApiRequest<AdmittedPod>("POST", `${podCollectionPath(input.namespace)}${DRY_RUN}`, { body: pod })
    return admitted.spec?.containers?.[0]?.image ?? "no image"
  } catch (e) {
    if (e instanceof KubeApiError && e.status === 403) return `denied: ${e.message}`
    throw e
  }
}

export async function waitUntilEffective(input: ManifestInput): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let last = "not checked"
  while (Date.now() < deadline) {
    last = await admittedImage(input)
    if (last === input.targetImage) return last
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return last
}
