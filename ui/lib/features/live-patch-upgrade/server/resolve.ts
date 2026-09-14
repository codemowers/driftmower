import "server-only"

import { getClusterResources } from "@/lib/cluster-resources/resources"
import { getResourceObject } from "@/lib/cluster-resources/resource-object"
import { collectOwnedPods, findWorkloadRoot } from "@/lib/cluster/workload-root"
import { fixHash } from "../hash"
import { APPS_KINDS, pickSourceImage, retag } from "../image-ref"
import { fixKey } from "../key"
import type { ManifestInput } from "../manifest"
import type { PolicyVersion, LivePatchUpgradeRequest, LivePatchUpgradeTarget } from "../types"
import { LivePatchUpgradeError } from "./error"

type PodSpec = { containers?: { image?: string }[]; initContainers?: { image?: string }[] }
type WorkloadObject = { spec?: { selector?: { matchLabels?: Record<string, string> }; template?: { spec?: PodSpec } } }
type PodObject = { spec?: PodSpec }
type Resolved = { podSelector: Record<string, string> | null; specImages: string[] }

const SELECTORLESS_MANAGERS = new Set(["argo", "operator"])

function specImages(spec: PodSpec | undefined): string[] {
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map(c => c.image ?? "")
}

async function appsWorkload(target: LivePatchUpgradeTarget): Promise<Resolved> {
  const workload = (await getResourceObject(target.kind, target.namespace, target.name)) as WorkloadObject | null
  if (!workload) throw new LivePatchUpgradeError(`${target.kind} ${target.namespace}/${target.name} not found`, 404)
  const matchLabels = workload.spec?.selector?.matchLabels ?? {}
  return {
    podSelector: Object.keys(matchLabels).length > 0 ? matchLabels : null,
    specImages: specImages(workload.spec?.template?.spec),
  }
}

async function otherWorkload(target: LivePatchUpgradeTarget): Promise<Resolved> {
  const resources = await getClusterResources()
  const rootUid = findWorkloadRoot(resources, target)?.uid ?? target.uid
  const pod = collectOwnedPods(resources, rootUid).find(p => p.namespace === target.namespace)
  if (!pod) throw new LivePatchUpgradeError(`${target.kind} ${target.namespace}/${target.name} has no running pods to read the image from`, 409)
  const object = (await getResourceObject("Pod", pod.namespace, pod.name)) as PodObject | null
  return { podSelector: null, specImages: specImages(object?.spec) }
}

export async function resolveInput(req: LivePatchUpgradeRequest, version: PolicyVersion): Promise<ManifestInput> {
  const { facts, target } = req
  const resolved = APPS_KINDS.has(target.kind) ? await appsWorkload(target) : await otherWorkload(target)
  const sourceImage = pickSourceImage(resolved.specImages, facts.repository, facts.from)
  if (!sourceImage) {
    const seen = resolved.specImages.filter(Boolean).join(", ") || "none"
    throw new LivePatchUpgradeError(`no container in ${target.kind} ${target.name} uses ${facts.repository}; images in the spec: ${seen}`, 409)
  }
  const key = fixKey(facts)
  return {
    key,
    hash: fixHash(key),
    namespace: target.namespace,
    sourceImage,
    targetImage: retag(sourceImage, facts.to),
    policyVersion: version,
    workload: { kind: target.kind, name: target.name, uid: target.uid },
    podSelector: SELECTORLESS_MANAGERS.has(facts.manager.kind) ? null : resolved.podSelector,
  }
}
