import type { ImageUsage } from "@/lib/cluster/reports"

const SHORT_DIGEST_LENGTH = 8

function digestHex(digest: string): string {
  const separator = digest.indexOf(":")
  return separator === -1 ? digest : digest.slice(separator + 1)
}

export function resolvedVersion(usage: ImageUsage): string | null {
  return usage.digestSemver?.tag || usage.actualTag || null
}

export function shortDigest(digest: string): string {
  return digestHex(digest).slice(0, SHORT_DIGEST_LENGTH)
}

export function digestCrumb(digest: string): string {
  const separator = digest.indexOf(":")
  const algorithm = separator === -1 ? "" : digest.slice(0, separator + 1)
  return `${algorithm}${shortDigest(digest)}…`
}

export function artifactTitle(repository: string, version: string | null): string {
  return version ? `${repository} ${version}` : repository
}

export function imagePath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/")
}
