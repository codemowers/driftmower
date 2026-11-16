"use client"

import PrefetchLink from "@/app/components/prefetch-link"
import { useContextHref } from "@/lib/hooks/use-context-href"

export default function GroupChip({ id }: { id: string }) {
  const { linkTo } = useContextHref()
  return (
    <PrefetchLink href={linkTo(`/groups/${encodeURIComponent(id)}`)} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:underline">
      {id}
    </PrefetchLink>
  )
}
