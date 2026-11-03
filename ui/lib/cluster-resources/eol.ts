import "server-only"

import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { parseKubeVersion } from "./k8s-versions"
import type { NodeSupport } from "./types"

export type EolProduct =
  | "kubernetes"
  | "amazon-eks"
  | "google-kubernetes-engine"
  | "azure-kubernetes-service"

export type Provider = { name: string; eolProduct: EolProduct }

type EolRelease = {
  name: string
  eolFrom: string | null
  eoesFrom?: string | null
}

const SUCCESS_TTL_MS = 60 * 60 * 1000
const FAILURE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const SUPPORT_WARN_MONTHS = 6
const SUPPORT_URGENT_MONTHS = 3
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

const cache = new Map<EolProduct, { value: EolRelease[] | null; at: number }>()

export function detectProvider(version: string): Provider {
  if (version.includes("-eks-")) return { name: "Amazon EKS", eolProduct: "amazon-eks" }
  if (version.includes("-gke.")) return { name: "GKE", eolProduct: "google-kubernetes-engine" }
  if (version.includes("+k3s")) return { name: "k3s", eolProduct: "kubernetes" }
  if (version.includes("+rke2")) return { name: "RKE2", eolProduct: "kubernetes" }
  if (version.includes("+k0s")) return { name: "k0s", eolProduct: "kubernetes" }
  return { name: "Kubernetes", eolProduct: "kubernetes" }
}

export async function fetchEolReleases(product: EolProduct): Promise<EolRelease[] | null> {
  const cached = cache.get(product)
  if (cached && Date.now() - cached.at < (cached.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
    return cached.value
  }
  try {
    const base = process.env.ENDOFLIFE_BASE_URL ?? "https://endoflife.date/api/v1/products"
    const res = await fetch(`${base}/${product}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`${product} -> ${res.status}`)
    const json = (await res.json()) as { result?: { releases?: EolRelease[] } }
    const releases = json.result?.releases
    if (!releases) throw new Error(`${product} missing result.releases`)
    cache.set(product, { value: releases, at: Date.now() })
    return releases
  } catch (e) {
    console.warn(`[eol] failed to resolve ${product} releases:`, (e as Error).message)
    cache.set(product, { value: null, at: Date.now() })
    return null
  }
}

const UNKNOWN: NodeSupport = { severity: "unknown", label: "Unknown", relative: "" }

function countdown(iso: string): string {
  return compactRelativeTimeFromNow(iso).replace(/^in /, "")
}

export function classifySupport(version: string, releases: EolRelease[] | null): NodeSupport {
  const parsed = parseKubeVersion(version)
  if (!parsed || !releases) return UNKNOWN

  const key = `${parsed[0]}.${parsed[1]}`
  const release = releases.find(r => r.name === key)
  const standardEnd = release?.eolFrom
  if (!standardEnd) return UNKNOWN

  const extendedEnd = release.eoesFrom ?? null
  const deathDate = extendedEnd ?? standardEnd
  const now = Date.now()

  if (now >= Date.parse(deathDate)) {
    return { severity: "eol", label: "EOL", relative: compactRelativeTimeFromNow(deathDate) }
  }
  if (extendedEnd && now >= Date.parse(standardEnd)) {
    return { severity: "extended", label: "Extended support", relative: countdown(extendedEnd) }
  }
  const msLeft = Date.parse(standardEnd) - now
  const severity =
    msLeft <= SUPPORT_URGENT_MONTHS * MONTH_MS ? "urgent"
      : msLeft <= SUPPORT_WARN_MONTHS * MONTH_MS ? "ending"
        : "ok"
  return { severity, label: "Supported", relative: countdown(standardEnd) }
}
