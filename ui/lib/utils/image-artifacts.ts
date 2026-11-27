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

// A lone "-" is never a valid OCI repository path component, so it separates
// the image name from its artifact and subpage: <image>/-/<artifact>[/sbom].
export function containerImageHref(key: string, artifact?: string, subpage?: "sbom" | "base-image" | "elf-interpreters"): string {
  const base = `/container-images/${imagePath(key)}`
  if (!artifact) return base
  return `${base}/-/${encodeURIComponent(artifact).replace(/%3A/gi, ":")}${subpage ? `/${subpage}` : ""}`
}

export function parseContainerImagePath(segments: string[]): { key: string; artifact?: string; subpage?: string } {
  const decoded = segments.map(decodeURIComponent).filter(Boolean)
  const split = decoded.indexOf("-")
  if (split < 0) return { key: decoded.join("/") }
  return { key: decoded.slice(0, split).join("/"), artifact: decoded[split + 1], subpage: decoded[split + 2] }
}

export type IntegrityInfo = { value: string; caption: string; textClass: string }
export type IntegrityStyle = { label: string; bg: string; text: string }

export function integrityInfo(usage: ImageUsage): IntegrityInfo {
  const pinned = usage.imageInfo.tag
  switch (usage.tagStatus) {
    case "match":
      return {
        value: "verified",
        caption: `${pinned} resolves to this digest`,
        textClass: "text-status-ok-label",
      }
    case "mismatch":
      return {
        value: "mismatch",
        caption: `pinned as ${pinned}, published as ${usage.actualTag}`,
        textClass: "text-status-minor-label",
      }
    case "digest_verification_failed":
      return {
        value: "unverified",
        caption: "this digest is not published under any tag",
        textClass: "text-muted-foreground",
      }
    case "no_digest":
      return {
        value: "not pinned",
        caption: "the pod spec carries no digest",
        textClass: "text-muted-foreground",
      }
    default:
      return {
        value: usage.tagStatus.replace(/_/g, " "),
        caption: "unrecognised verification result",
        textClass: "text-muted-foreground",
      }
  }
}

const INTEGRITY_STYLE: Record<string, IntegrityStyle> = {
  match:                      { label: "verified",   bg: "bg-status-ok-bg",    text: "text-status-ok-label" },
  mismatch:                   { label: "mismatch",   bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  digest_verification_failed: { label: "unverified", bg: "bg-gray-100",        text: "text-muted-foreground" },
  no_digest:                  { label: "not pinned", bg: "bg-gray-100",        text: "text-muted-foreground" },
}

export function integrityStyle(tagStatus: string): IntegrityStyle {
  return INTEGRITY_STYLE[tagStatus] ?? {
    label: tagStatus.replace(/_/g, " "),
    bg: "bg-gray-100",
    text: "text-muted-foreground",
  }
}
