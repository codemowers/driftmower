export type AiInsights = {
  role: string
  importance: string
  confidence: string
  explanation: string
  evidenceRefs: string[]
}

export type EvidenceSignal = {
  key: string
  value: string
  note?: string
}

export type ParsedEvidence = {
  signals: EvidenceSignal[]
  rules: string[]
}

export type InsightDetails = {
  summary: string
  signals: EvidenceSignal[]
}

export type WorkloadRecord = {
  id: string
  workloadKey: string
  reportId: string
  revision: number
  status: string
  aiInsights: string | null
  data: string
  createdAt: string
  updatedAt: string | null
}

export type WorkloadsResponse = {
  total: number
  limit: number
  skip: number
  data: WorkloadRecord[]
}
