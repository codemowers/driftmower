import "server-only"

import { KubeApiError, kubeApiGet, kubeApiRequest } from "@/lib/server/k8s"
import { fixHash, objectName } from "../hash"
import { fixKey } from "../key"
import { buildLivePatchUpgradeObjects, livePatchUpgradeYaml, NAMESPACE_ANNOTATION, type KubeObject, type ManifestInput } from "../manifest"
import type { PolicyVersion, LivePatchUpgradeListResponse, LivePatchUpgradePreviewResponse, LivePatchUpgradeRequest } from "../types"
import { getLivePatchUpgradeAvailability } from "./availability"
import { waitUntilEffective } from "./effective"
import { LivePatchUpgradeError } from "./error"
import { listLivePatchUpgrades } from "./list"
import { bindingPath, configMapPath, DRY_RUN, policyPath } from "./paths"
import { resolveInput } from "./resolve"
import { ignoreNotFound, restartWorkload } from "@/lib/server/restart-workload"

const ALREADY_EXISTS = 409

type Step = { kind: string; collection: string; item: string; body: KubeObject }

function steps(input: ManifestInput, version: PolicyVersion): Step[] {
  const { params, policy, binding } = buildLivePatchUpgradeObjects(input)
  const name = objectName(input.hash)
  return [
    { kind: "ConfigMap", collection: configMapPath(input.namespace), item: configMapPath(input.namespace, name), body: params },
    { kind: "MutatingAdmissionPolicy", collection: policyPath(version), item: policyPath(version, name), body: policy },
    { kind: "MutatingAdmissionPolicyBinding", collection: bindingPath(version), item: bindingPath(version, name), body: binding },
  ]
}

type ExistingObject = { metadata?: { annotations?: Record<string, string> } }

// These objects are cluster-scoped and named from a hash of the action key, so
// the name alone carries no tenancy. Every path that deletes or replaces one
// checks the namespace the object recorded at creation against the namespace
// this request was authorized for.
//
// Without it, sending another sandbox's facts with your own target.namespace
// passes the namespace guard and then addresses their object -- and for the
// `argo` manager the key holds no namespace at all, so the names collide by
// construction rather than by malice.
async function assertOwned(path: string, namespace: string): Promise<void> {
  let existing: ExistingObject
  try {
    existing = await kubeApiGet<ExistingObject>(path)
  } catch (e) {
    // Nothing there is nothing to protect; the caller creates it next.
    if (e instanceof KubeApiError && e.status === 404) return
    throw e
  }

  const owner = existing?.metadata?.annotations?.[NAMESPACE_ANNOTATION]
  if (owner && owner !== namespace) {
    throw new LivePatchUpgradeError(`that temporary fix belongs to ${owner}, not ${namespace}`, 403)
  }
}

async function createReplacing(step: Step, suffix: string, namespace: string): Promise<void> {
  try {
    await kubeApiRequest("POST", `${step.collection}${suffix}`, { body: step.body })
  } catch (e) {
    if (!(e instanceof KubeApiError) || e.status !== ALREADY_EXISTS || suffix) throw e
    await assertOwned(step.item, namespace)
    await kubeApiRequest("DELETE", step.item)
    await kubeApiRequest("POST", step.collection, { body: step.body })
  }
}

async function requireVersion(): Promise<PolicyVersion> {
  const { version } = await getLivePatchUpgradeAvailability()
  if (!version) throw new LivePatchUpgradeError("cluster does not serve MutatingAdmissionPolicy", 503)
  return version
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function previewLivePatchUpgrade(req: LivePatchUpgradeRequest): Promise<LivePatchUpgradePreviewResponse> {
  const input = await resolveInput(req, await requireVersion())
  return { yaml: livePatchUpgradeYaml(buildLivePatchUpgradeObjects(input)), name: objectName(input.hash) }
}

export async function applyLivePatchUpgrade(req: LivePatchUpgradeRequest, actor: string): Promise<LivePatchUpgradeListResponse> {
  const version = await requireVersion()
  const input = await resolveInput(req, version)
  const suffix = req.dryRun ? DRY_RUN : ""
  const created: Step[] = []

  console.info(`[live-patch-upgrade] apply by ${actor} key=${input.key} hash=${input.hash} ns=${input.namespace}${suffix && " dry-run"}`)

  for (const step of steps(input, version)) {
    try {
      await createReplacing(step, suffix, input.namespace)
      created.push(step)
    } catch (e) {
      for (const done of created.reverse()) await ignoreNotFound(() => kubeApiRequest("DELETE", done.item))
      throw new LivePatchUpgradeError(`${step.kind} could not be written, nothing was written: ${message(e)}`, 502)
    }
  }

  if (!req.dryRun) {
    const admitted = await waitUntilEffective(input)
    if (admitted !== input.targetImage) {
      throw new LivePatchUpgradeError(`objects written but a test pod still admits with ${admitted} instead of ${input.targetImage}; not restarting`, 502)
    }
    try {
      await restartWorkload(req.target, req.facts.manager.kind)
    } catch (e) {
      throw new LivePatchUpgradeError(`objects written but the restart failed: ${message(e)}`, 502)
    }
  }

  return await listLivePatchUpgrades()
}

export async function removeLivePatchUpgrade(req: LivePatchUpgradeRequest, actor: string): Promise<LivePatchUpgradeListResponse> {
  const version = await requireVersion()
  const key = fixKey(req.facts)
  const name = objectName(fixHash(key))

  console.info(`[live-patch-upgrade] remove by ${actor} key=${key} ns=${req.target.namespace}`)

  for (const path of [bindingPath(version, name), policyPath(version, name), configMapPath(req.target.namespace, name)]) {
    // Before the delete, not after: the name came from facts the caller sent,
    // and only the object itself says which namespace it belongs to.
    await assertOwned(path, req.target.namespace)
    try {
      await ignoreNotFound(() => kubeApiRequest("DELETE", path))
    } catch (e) {
      throw new LivePatchUpgradeError(`${path} could not be deleted: ${message(e)}`, 502)
    }
  }

  try {
    await restartWorkload(req.target, req.facts.manager.kind)
  } catch (e) {
    throw new LivePatchUpgradeError(`objects removed but the restart failed: ${message(e)}`, 502)
  }

  return await listLivePatchUpgrades()
}
