export const OCI_BASE_NAME = "org.opencontainers.image.base.name"
export const OCI_SOURCE = "org.opencontainers.image.source"
export const OCI_REVISION = "org.opencontainers.image.revision"
export const OCI_CREATED = "org.opencontainers.image.created"
export const OCI_DOCUMENTATION = "org.opencontainers.image.documentation"

const OCI_PREFIX = "org.opencontainers.image."

const LABEL_PRIORITY = [
  "version", "release", "licenses", "created", "revision",
  "title", "name", "vendor", "authors", "maintainer",
  "source", "url", "documentation",
  "base.name", "base.digest",
]

const SENTENCE_KEYS = new Set(["description", "summary"])
const SENTENCE_VALUE_LENGTH = 100

export function stripOciPrefix(key: string): string {
  return key.startsWith(OCI_PREFIX) ? key.slice(OCI_PREFIX.length) : key
}

function labelRank(key: string, value: string): number {
  const stripped = stripOciPrefix(key)
  if (SENTENCE_KEYS.has(stripped) || value.length > SENTENCE_VALUE_LENGTH) return LABEL_PRIORITY.length + 1
  const index = LABEL_PRIORITY.indexOf(stripped)
  return index === -1 ? LABEL_PRIORITY.length : index
}

export function sortedLabelEntries(labels: Record<string, string> | undefined): Array<[string, string]> {
  const sorted = Object.entries(labels ?? {}).sort((a, b) =>
    labelRank(...a) - labelRank(...b) || stripOciPrefix(a[0]).localeCompare(stripOciPrefix(b[0])),
  )
  return sorted.filter(([key, value], i) => {
    const prev = sorted[i - 1]
    return !prev || stripOciPrefix(prev[0]) !== stripOciPrefix(key) || prev[1] !== value
  })
}

export function sourceRepoUrl(labels: Record<string, string> | undefined): string | null {
  const source = labels?.[OCI_SOURCE]
  if (!source?.startsWith("http")) return null
  return source.replace(/\.git$/, "")
}
