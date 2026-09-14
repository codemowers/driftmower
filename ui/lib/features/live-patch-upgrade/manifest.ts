import { emitYamlLines, yamlText } from "../yaml/yaml-lines.ts"
import { objectName } from "./hash.ts"
import type { PolicyVersion } from "./types.ts"

export const LIVE_PATCH_UPGRADE_LABEL = "driftmower.io/live-patch-upgrade"
export const ACTION_HASH_LABEL = "driftmower.io/action-hash"
export const WORKLOAD_UID_LABEL = "driftmower.io/workload-uid"
export const ACTION_KEY_ANNOTATION = "driftmower.io/action-key"
export const NAMESPACE_ANNOTATION = "driftmower.io/namespace"
export const WORKLOAD_KIND_ANNOTATION = "driftmower.io/workload-kind"
export const WORKLOAD_NAME_ANNOTATION = "driftmower.io/workload-name"

export const ADMISSION_GROUP = "admissionregistration.k8s.io"

function celString(value: string): string {
  return JSON.stringify(value)
}

export function sourceImagePresentExpression(sourceImage: string): string {
  const source = celString(sourceImage)
  return (
    `object.spec.containers.exists(container, container.image == ${source}) || ` +
    `(has(object.spec.initContainers) && object.spec.initContainers.exists(container, container.image == ${source}))`
  )
}

export function rewriteImageExpression(sourceImage: string, targetImage: string): string {
  const source = celString(sourceImage)
  const target = celString(targetImage)
  return (
    "Object{ spec: Object.spec{ " +
    `containers: object.spec.containers.filter(container, container.image == ${source})` +
    `.map(container, Object.spec.containers{ name: container.name, image: ${target} }), ` +
    `initContainers: has(object.spec.initContainers) ? object.spec.initContainers.filter(container, container.image == ${source})` +
    `.map(container, Object.spec.initContainers{ name: container.name, image: ${target} }) : [] ` +
    "} }"
  )
}

export type ManifestInput = {
  key: string
  hash: string
  namespace: string
  sourceImage: string
  targetImage: string
  policyVersion: PolicyVersion
  workload: { kind: string; name: string; uid: string }
  podSelector: Record<string, string> | null
}

export type KubeObject = Record<string, unknown>

export type LivePatchUpgradeObjects = {
  policy: KubeObject
  binding: KubeObject
}

function metadata(input: ManifestInput): KubeObject {
  return {
    name: objectName(input.hash),
    labels: {
      [LIVE_PATCH_UPGRADE_LABEL]: "true",
      [ACTION_HASH_LABEL]: input.hash,
      [WORKLOAD_UID_LABEL]: input.workload.uid,
    },
    annotations: {
      [ACTION_KEY_ANNOTATION]: input.key,
      [NAMESPACE_ANNOTATION]: input.namespace,
      [WORKLOAD_KIND_ANNOTATION]: input.workload.kind,
      [WORKLOAD_NAME_ANNOTATION]: input.workload.name,
    },
  }
}

export function buildLivePatchUpgradeObjects(input: ManifestInput): LivePatchUpgradeObjects {
  const name = objectName(input.hash)
  const apiVersion = `${ADMISSION_GROUP}/${input.policyVersion}`
  const policy: KubeObject = {
    apiVersion,
    kind: "MutatingAdmissionPolicy",
    metadata: metadata(input),
    spec: {
      failurePolicy: "Fail",
      reinvocationPolicy: "Never",
      matchConstraints: {
        resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"], scope: "Namespaced" }],
        ...(input.podSelector ? { objectSelector: { matchLabels: input.podSelector } } : {}),
      },
      matchConditions: [{ name: "exact-source-image-is-present", expression: sourceImagePresentExpression(input.sourceImage) }],
      mutations: [{ patchType: "ApplyConfiguration", applyConfiguration: { expression: rewriteImageExpression(input.sourceImage, input.targetImage) } }],
    },
  }
  const binding: KubeObject = {
    apiVersion,
    kind: "MutatingAdmissionPolicyBinding",
    metadata: metadata(input),
    spec: {
      policyName: name,
      matchResources: {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": input.namespace } },
      },
    },
  }
  return { policy, binding }
}

export function livePatchUpgradeYaml(objects: LivePatchUpgradeObjects): string {
  return [objects.policy, objects.binding].map(object => yamlText(emitYamlLines(object))).join("---\n")
}
