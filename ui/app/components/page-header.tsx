"use client"

import type { ReactNode } from "react"
import LoadError from "./load-error"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { fetchDynamicData } from "@/lib/cluster/dynamic-data"

type Props = {
  title: string
  subtitle: string
  accessory?: ReactNode
}

export default function PageHeader({ title, subtitle, accessory }: Props) {
  const error = useClusterState(s => s.error)
  const retry = () => void fetchDynamicData()
  return (
    <>
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2.5">
            <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            {accessory}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="shrink-0 p-1">
        </div>
      </header>
      {error && <LoadError message={error} onRetry={retry} />}
    </>
  )
}
