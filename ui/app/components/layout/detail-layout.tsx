import type { ReactNode } from "react"

// Resource detail body shared by cluster, namespace, workload and Pod pages:
// commands and findings in the main column, statistics and usage in the aside.
export default function DetailLayout({ main, aside }: { main: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,36%)]">
      <div className="flex min-w-0 flex-col gap-6">{main}</div>
      <aside className="flex min-w-0 flex-col gap-6">{aside}</aside>
    </div>
  )
}
