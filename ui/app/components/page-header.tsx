"use client"

import Refreshbutton from "./refresh-button"

type Props = {
  title: string
  subtitle: string
}

export default function PageHeader({ title, subtitle }: Props) {
  return (
    <header className="flex items-start justify-between gap-8">
      <div className="flex flex-col gap-0.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <Refreshbutton />
    </header>
  )
}
