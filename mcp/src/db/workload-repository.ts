export interface WorkloadRepository {
  searchMatchingGroups(query: string, limit: number): Promise<unknown[]>
}
