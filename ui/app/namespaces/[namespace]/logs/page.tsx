"use client"

import { useParams } from "next/navigation"
import Breadcrumbs from "@/app/components/breadcrumbs"
import LogsTab from "@/app/topmost-owners/[uid]/[podUid]/components/logs-tab"
import { useContextHref } from "@/lib/hooks/use-context-href"

// A namespace's logs: every container of every Pod, merged in time order.
export default function NamespaceLogsPage() {
  const { namespace } = useParams<{ namespace: string }>()
  const name = decodeURIComponent(namespace)
  const { linkTo } = useContextHref()
  return (
    <div className="flex h-full flex-col">
      <main className="flex min-h-0 w-full flex-1 flex-col gap-4 px-7 py-6">
        <Breadcrumbs items={[
          { label: "Workloads", href: linkTo("/topmost-owners") },
          { label: `Namespace ${name}`, href: linkTo(`/namespaces/${encodeURIComponent(name)}`) },
          { label: "Logs" },
        ]} />
        <LogsTab namespace={name} />
      </main>
    </div>
  )
}
