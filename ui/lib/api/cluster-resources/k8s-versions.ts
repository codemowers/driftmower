import type { StatusType } from "@/lib/cluster/reports"
import type { K8sReference } from "./types"

export type Distro = "k3s" | "rke2" | "vanilla"

const SUCCESS_TTL_MS = 60 * 60 * 1000
const FAILURE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

const cache = new Map<Distro, { value: K8sReference | null; at: number }>()

export function detectDistro(version: string): Distro {
  if (version.includes("+k3s")) return "k3s"
  if (version.includes("+rke2")) return "rke2"
  return "vanilla"
}

export function parseKubeVersion(raw: string): [number, number, number] | null {
  if (!raw) return null
  const core = raw.trim().replace(/^v/i, "").split("+")[0].split("-")[0]
  const [major, minor, patch] = core.split(".").map(Number)
  if (![major, minor].every(Number.isFinite)) return null
  return [major, minor, Number.isFinite(patch) ? patch : 0]
}

export function classifyDrift(running: string, target: string): StatusType {
  const r = parseKubeVersion(running)
  const t = parseKubeVersion(target)
  if (!r || !t) return "no_data"
  for (let i = 0; i < 3; i++) {
    if (r[i] === t[i]) continue
    if (r[i] > t[i]) return "ahead"
    return (["major_behind", "minor_behind", "patch_behind"] as const)[i]
  }
  return "up_to_date"
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return (await res.text()).trim()
}

async function fetchChannels(url: string): Promise<{ stable: string; latest: string }> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  const json = (await res.json()) as { data?: { name: string; latest: string }[] }
  const latestOf = (name: string) => json.data?.find(c => c.name === name)?.latest
  const stable = latestOf("stable")
  const latest = latestOf("latest")
  if (!stable || !latest) throw new Error(`${url} missing stable/latest channels`)
  return { stable, latest }
}

const SOURCES: Record<Distro, () => Promise<{ stable: string; latest: string }>> = {
  k3s: () => fetchChannels(process.env.K8S_VERSION_CHANNELS_URL_K3S ?? "https://update.k3s.io/v1-release/channels"),
  rke2: () => fetchChannels(process.env.K8S_VERSION_CHANNELS_URL_RKE2 ?? "https://update.rke2.io/v1-release/channels"),
  vanilla: async () => {
    const [stable, latest] = await Promise.all([
      fetchText(process.env.K8S_VERSION_STABLE_URL ?? "https://dl.k8s.io/release/stable.txt"),
      fetchText(process.env.K8S_VERSION_LATEST_URL ?? "https://dl.k8s.io/release/latest.txt"),
    ])
    return { stable, latest }
  },
}

export async function resolveReference(distro: Distro): Promise<K8sReference | null> {
  const cached = cache.get(distro)
  if (cached && Date.now() - cached.at < (cached.value ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
    return cached.value
  }
  try {
    const { stable, latest } = await SOURCES[distro]()
    const value: K8sReference = { stable, latest }
    cache.set(distro, { value, at: Date.now() })
    return value
  } catch (e) {
    console.warn(`[k8s-versions] failed to resolve ${distro} reference:`, (e as Error).message)
    cache.set(distro, { value: null, at: Date.now() })
    return null
  }
}
