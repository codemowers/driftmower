import { TriangleAlert } from "lucide-react"
import { issueRank, issueCounts, ISSUE_STYLE, type WorkloadIssue } from "@/lib/cluster/issues"
import { cn } from "@/lib/utils/cn"

export default function IssueIndicator({ issues }: { issues?: WorkloadIssue[] }) {
  if (!issues?.length) return null
  const { worst } = issueRank(issues)
  const title = issues.map(issue => `${issue.message}${issueCounts(issue) ? ` (${issueCounts(issue)})` : ""}`).join("\n")
  return <span title={title} aria-label={`${issues.length} ${issues.length === 1 ? "issue" : "issues"}`} className="inline-flex shrink-0 items-center">
    <TriangleAlert className={cn("size-4", worst && ISSUE_STYLE[worst].text)} />
  </span>
}
