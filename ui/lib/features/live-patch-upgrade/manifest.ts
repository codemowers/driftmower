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

const SOURCE_IMAGE_PRESENT =
  "params != null && 'sourceImage' in params.data && " +
  "(object.spec.containers.exists(container, container.image == params.data.sourceImage) || " +
  "(has(object.spec.initContainers) && object.spec.initContainers.exists(container, container.image == params.data.sourceImage)))"

const TARGET_IMAGE_CONFIGURED = "params != null && 'targetImage' in params.data && params.data.targetImage != ''"

const REWRITE_IMAGE =
  "Object{ spec: Object.spec{ " +
  "containers: object.spec.containers.filter(container, container.image == params.data.sourceImage)" +
  ".map(container, Object.spec.containers{ name: container.name, image: params.data.targetImage }), " +
  "initContainers: has(object.spec.initContainers) ? object.spec.initContainers.filter(container, container.image == params.data.sourceImage)" +
  ".map(container, Object.spec.initContainers{ name: container.name, image: params.data.targetImage }) : [] " +
  "} }"

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
  params: KubeObject
  policy: KubeObject
  binding: KubeObject
}

function metadata(input: ManifestInput, namespace?: string): KubeObject {
  return {
    name: objectName(input.hash),
    ...(namespace ? { namespace } : {}),
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
  const params: KubeObject = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadata(input, input.namespace),
    data: { sourceImage: input.sourceImage, targetImage: input.targetImage },
  }
  const policy: KubeObject = {
    apiVersion,
    kind: "MutatingAdmissionPolicy",
    metadata: metadata(input),
    spec: {
      failurePolicy: "Fail",
      reinvocationPolicy: "Never",
      paramKind: { apiVersion: "v1", kind: "ConfigMap" },
      matchConstraints: {
        resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"], scope: "Namespaced" }],
        ...(input.podSelector ? { objectSelector: { matchLabels: input.podSelector } } : {}),
      },
      matchConditions: [
        { name: "exact-source-image-is-present", expression: SOURCE_IMAGE_PRESENT },
        { name: "target-image-is-configured", expression: TARGET_IMAGE_CONFIGURED },
      ],
      mutations: [{ patchType: "ApplyConfiguration", applyConfiguration: { expression: REWRITE_IMAGE } }],
    },
  }
  const binding: KubeObject = {
    apiVersion,
    kind: "MutatingAdmissionPolicyBinding",
    metadata: metadata(input),
    spec: {
      policyName: name,
      paramRef: { name, namespace: input.namespace, parameterNotFoundAction: "Deny" },
      matchResources: {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": input.namespace } },
      },
    },
  }
  return { params, policy, binding }
}

export function livePatchUpgradeYaml(objects: LivePatchUpgradeObjects): string {
  return [objects.params, objects.policy, objects.binding].map(object => yamlText(emitYamlLines(object))).join("---\n")
}
