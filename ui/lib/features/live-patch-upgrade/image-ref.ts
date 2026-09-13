import type { LivePatchUpgradeTarget } from "./types.ts"

export const APPS_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"])

function stripDigest(image: string): string {
  return image.split("@")[0]
}

function splitTag(image: string): { repository: string; tag: string | null } {
  const withoutDigest = stripDigest(image)
  const lastSlash = withoutDigest.lastIndexOf("/")
  const lastColon = withoutDigest.lastIndexOf(":")
  if (lastColon > lastSlash) return { repository: withoutDigest.slice(0, lastColon), tag: withoutDigest.slice(lastColon + 1) }
  return { repository: withoutDigest, tag: null }
}

export function imageRepository(image: string): string {
  return splitTag(image).repository
}

export function imageTag(image: string): string | null {
  return splitTag(image).tag
}

export function retag(image: string, tag: string): string {
  return `${imageRepository(image)}:${tag}`
}

function sameRepository(candidate: string, repository: string): boolean {
  const a = imageRepository(candidate)
  const b = imageRepository(repository)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`) || a.split("/").pop() === b.split("/").pop()
}

export function pickSourceImage(candidates: string[], repository: string, from: string): string | null {
  const inRepository = candidates.filter(c => c !== "" && sameRepository(c, repository))
  return inRepository.find(c => imageTag(c) === from) ?? inRepository[0] ?? null
}

export function restartCommand(target: LivePatchUpgradeTarget): string {
  if (APPS_KINDS.has(target.kind)) {
    return `kubectl rollout restart ${target.kind.toLowerCase()}/${target.name} -n ${target.namespace}`
  }
  return `kubectl delete pods -n ${target.namespace} -l <pod selector of ${target.kind} ${target.name}>`
}
