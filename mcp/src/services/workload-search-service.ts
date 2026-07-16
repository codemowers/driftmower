import type { SearchWorkloadsResult } from '../domain/workload-result.js'

export interface WorkloadSearchService {
  searchWorkloads(query: string, limit?: number): Promise<SearchWorkloadsResult>
}
