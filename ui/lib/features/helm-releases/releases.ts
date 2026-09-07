import "server-only"

import { gunzipSync } from "node:zlib"
import { kubeApiGet } from "@/lib/server/k8s"

const MAX_CACHED_RELEASES = 64
const GZIP_MAGIC = 0x1f8b

const DOCUMENT_SEPARATOR = /^---\s*$/m
const SOURCE_COMMENT = /^# Source:\s*(\S+)/m
const DOCUMENT_KIND = /^kind:[ \t]*(\S+)/m
const DOCUMENT_NAME = /^metadata:\n(?:[ \t]+.*\n)*?[ \t]+name:[ \t]*(\S+)/m

type StoredRelease = {
  name: string
  namespace: string
  version: number
  info?: { status?: string }
  config?: Record<string, unknown>
  manifest?: string
  chart?: {
    metadata?: { name?: string; version?: string; appVersion?: string }
    values?: Record<string, unknown>
  }
}

type SecretList = {
  items: {
    metadata: { labels?: Record<string, string> }
    data?: { release?: string }
  }[]
}

export type ReleaseIdentity = {
  name: string
  namespace: string
  revision: number
  status: string
  chartName: string
  chartVersion: string
  chartAppVersion: string
}

export type ReleaseValues = ReleaseIdentity & {
  overrides: Record<string, unknown>
  defaults: Record<string, unknown>
}

export type ManifestDocumentSummary = {
  index: number
  kind: string
  name: string
  source: string
  lineCount: number
}

export type ManifestIndex = ReleaseIdentity & {
  documents: ManifestDocumentSummary[]
  totalLines: number
}

export type ManifestDocument = ManifestDocumentSummary & { text: string }

const releaseCache = new Map<string, StoredRelease>()

function remember(key: string, release: StoredRelease): void {
  if (releaseCache.size >= MAX_CACHED_RELEASES) {
    const oldest = releaseCache.keys().next().value
    if (oldest !== undefined) releaseCache.delete(oldest)
  }
  releaseCache.set(key, release)
}

function decodeRelease(payload: string): StoredRelease {
  const bytes = Buffer.from(payload, "base64")
  const gzipped = bytes.length > 1 && bytes.readUInt16BE(0) === GZIP_MAGIC
  const json = gzipped ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8")
  return JSON.parse(json) as StoredRelease
}

function selector(name: string): string {
  return encodeURIComponent(`owner=helm,name=${name},status=deployed`)
}

async function getRelease(namespace: string, name: string): Promise<StoredRelease | null> {
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets?labelSelector=${selector(name)}`
  const secret = (await kubeApiGet<SecretList>(path)).items[0]
  if (!secret?.data?.release) return null

  const key = `${namespace}/${name}/${secret.metadata.labels?.version ?? "0"}`
  const cached = releaseCache.get(key)
  if (cached) return cached

  const release = decodeRelease(Buffer.from(secret.data.release, "base64").toString("utf8"))
  remember(key, release)
  return release
}

function identity(release: StoredRelease): ReleaseIdentity {
  return {
    name: release.name,
    namespace: release.namespace,
    revision: release.version,
    status: release.info?.status ?? "",
    chartName: release.chart?.metadata?.name ?? "",
    chartVersion: release.chart?.metadata?.version ?? "",
    chartAppVersion: release.chart?.metadata?.appVersion ?? "",
  }
}

export async function getReleaseValues(namespace: string, name: string): Promise<ReleaseValues | null> {
  const release = await getRelease(namespace, name)
  if (!release) return null

  return {
    ...identity(release),
    overrides: release.config ?? {},
    defaults: release.chart?.values ?? {},
  }
}

const DATA_BLOCK_START = /^(data|stringData):/
const DATA_ENTRY = /^(\s+)([^:]+):\s*\S/

function redactSecretData(text: string): string {
  let inDataBlock = false

  return text
    .split("\n")
    .map(line => {
      if (DATA_BLOCK_START.test(line)) {
        inDataBlock = true
        return line
      }
      if (inDataBlock && /^\S/.test(line)) inDataBlock = false
      if (!inDataBlock) return line

      const entry = DATA_ENTRY.exec(line)
      return entry ? `${entry[1]}${entry[2]}: [redacted]` : line
    })
    .join("\n")
}

function splitDocuments(manifest: string): ManifestDocument[] {
  return manifest
    .split(DOCUMENT_SEPARATOR)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map((chunk, index) => {
      const body = chunk
        .split("\n")
        .filter(line => !line.startsWith("# Source:"))
        .join("\n")
        .trim()

      const kind = DOCUMENT_KIND.exec(body)?.[1] ?? "Document"
      const text = kind === "Secret" ? redactSecretData(body) : body

      return {
        index,
        kind,
        name: DOCUMENT_NAME.exec(text)?.[1] ?? "",
        source: SOURCE_COMMENT.exec(chunk)?.[1] ?? "",
        lineCount: text.split("\n").length,
        text,
      }
    })
}

export async function getReleaseManifest(namespace: string, name: string): Promise<ManifestIndex | null> {
  const release = await getRelease(namespace, name)
  if (!release) return null

  const documents = splitDocuments(release.manifest ?? "")

  return {
    ...identity(release),
    documents: documents.map(({ index, kind, name: documentName, source, lineCount }) => ({
      index,
      kind,
      name: documentName,
      source,
      lineCount,
    })),
    totalLines: documents.reduce((total, document) => total + document.lineCount, 0),
  }
}

export async function getReleaseManifestText(namespace: string, name: string): Promise<string | null> {
  const release = await getRelease(namespace, name)
  if (!release) return null

  return splitDocuments(release.manifest ?? "")
    .map(document => (document.source ? `# Source: ${document.source}\n${document.text}` : document.text))
    .join("\n---\n")
}

export async function getReleaseManifestDocument(
  namespace: string,
  name: string,
  index: number,
): Promise<ManifestDocument | null> {
  const release = await getRelease(namespace, name)
  if (!release) return null

  return splitDocuments(release.manifest ?? "")[index] ?? null
}
