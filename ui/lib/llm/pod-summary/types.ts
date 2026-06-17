import type { StatusType } from "@/lib/cluster/reports"
import type { VulnerabilitySeverity } from "@/lib/cluster/vulnerability/types"

export type PodSummaryKind = "static" | "live"

export type EolStatus = "ok" | "imminent" | "past"
export type RiskDriver = "cve" | "eol" | "drift" | "none"
export type Confidence = "high" | "low"

export type WorstCve = {
  id: string
  severity: VulnerabilitySeverity
  score: number
  fixedVersion: string
}

export type ImageFacts = {
  repo: string
  runTag: string | null
  latestTag: string | null
  drift: StatusType
  major: number
  minor: number
  patch: number
  builtAgeDays: number | null
  eol: EolStatus
  scanned: boolean
  cve: { critical: number; high: number; worst: WorstCve | null } | null
}

export type StaticFacts = {
  images: ImageFacts[]
  riskDriver: RiskDriver
  fixAvailable: boolean
  confidence: Confidence
  worstSeverity: VulnerabilitySeverity | null
}

export type StaticRisk = {
  riskDriver: RiskDriver
  worstSeverity: VulnerabilitySeverity | null
}

export type LiveFacts = {
  pod: { name: string; namespace: string; node: string | null; phase: string }
  net: {
    listening: { port: number; protocol: string }[]
    inbound: { external: number; internal: number }
    externalInboundPeers: string[]
    outboundWorkloads: string[]
    outboundCount: number
    externalEndpoints: number
    hidden: number
  }
  staticRisk?: StaticRisk
}
