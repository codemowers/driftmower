"use client"

import type { ReactNode } from "react"
import RefreshButton from "./core/refresh-button"

type Props = {
  title: string
  subtitle: string
  accessory?: ReactNode
}

export default function PageHeader({ title, subtitle, accessory }: Props) {
  return (
    <header className="flex items-start justify-between gap-8">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {accessory}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="shrink-0 p-1">
        <RefreshButton />
      </div>

    </header>
  )
}
