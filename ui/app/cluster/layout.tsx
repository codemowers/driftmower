import type { ReactNode } from "react"
import { notFound } from "next/navigation"

import { callerSeesClusterWideViews } from "@/lib/server/sandbox-scope-filter"

// Hidden, not merely unlinked: a sandbox user who types /cluster or follows an
// older link gets the same 404 as the nav entry they never see. Server-side so
// there is no frame in which the page renders before the answer arrives.
export default async function ClusterLayout({ children }: { children: ReactNode }) {
  if (!(await callerSeesClusterWideViews())) notFound()

  return children
}
