"use client"

import IssuesCard from "./issues-card"
import AdvisoriesCard from "./advisories-card"
import VulnerabilitiesCard from "./vulnerabilities-card"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { scopeImageIssues, type FindingScope } from "@/lib/cluster/scope"
import { driftIssues, type WorkloadIssue } from "@/lib/cluster/issues"
import { useScopeUsages } from "@/lib/hooks/use-scope"

// Issues, security advisories and vulnerabilities of one scope, in the same
// order and shape on the cluster, namespace, workload and Pod views.
export default function ScopeFindings({ scope, resourceIssues, limit = 5 }: { scope: FindingScope; resourceIssues?: WorkloadIssue[]; limit?: number }) {
  const issues = useClusterState(s => s.data?.issues)
  const usages = useScopeUsages(scope)
  return (
    <>
      <IssuesCard resourceIssues={[...(resourceIssues ?? []), ...driftIssues(usages ?? [])]} imageIssues={usages && issues ? scopeImageIssues(issues, usages) : []} limit={limit} />
      <AdvisoriesCard usages={usages} limit={limit} />
      {usages && <VulnerabilitiesCard usages={usages} limit={limit} />}
    </>
  )
}
