"use client"

import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import LoadError from "./load-error"
import HeaderIcon from "./layout/header-icon"
import { useClusterState } from "@/lib/cluster/cluster-state"

type Props = {
  icon: LucideIcon
  title: string
  subtitle?: string
  accessory?: ReactNode
  actions?: ReactNode
}

export default function PageHeader({ icon, title, subtitle, accessory, actions }: Props) {
  const error = useClusterState(s => s.error)
  const retry = () => window.dispatchEvent(new Event("driftmower:refresh-inventory"))
  return (
    <>
      <header className="flex items-start justify-between gap-8">
        <div className="flex items-center gap-3">
          <HeaderIcon icon={icon} label={title} />
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2.5">
              <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
              {accessory}
            </div>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="ml-auto shrink-0 self-center">{actions}</div>}
      </header>
      {error && <LoadError message={error} onRetry={retry} />}
    </>
  )
}
