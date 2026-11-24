"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import ResourceHeader from "@/app/components/resource-header"
import { NamespaceNav } from "@/app/components/layout/resource-navs"
import LogsTab from "@/app/topmost-owners/[uid]/[podUid]/components/logs-tab"
import { useContextHref } from "@/lib/hooks/use-context-href"

// A namespace's logs: every container of every Pod, merged in time order.
export default function NamespaceLogsPage() {
  const { namespace } = useParams<{ namespace: string }>()
  const name = decodeURIComponent(namespace)
  const { linkTo } = useContextHref()
  return (
    <div className="flex h-full flex-col">
      <Page fill>
        <ResourceHeader icon={ICONS.logs} iconAriaLabel="Namespace logs" title={name} copyValue={name} subtitle="Logs of every container in this namespace"
          breadcrumbs={[
            { label: "Namespaces", href: linkTo("/namespaces") },
            { label: `Namespace ${name}`, href: linkTo(`/namespaces/${encodeURIComponent(name)}`) },
            { label: "Logs" },
          ]} />
        <NamespaceNav namespace={name} />
        <LogsTab namespace={name} />
      </Page>
    </div>
  )
}
