import type { ReactNode } from "react"
import { cn } from "@/lib/utils/cn"

// The page shell. Document pages scroll; fill pages (logs, topology) take the
// viewport height and let their content scroll.
export default function Page({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  return (
    <main className={cn("flex w-full flex-1 flex-col px-7", fill ? "min-h-0 gap-4 py-6" : "gap-6 py-8")}>
      {children}
    </main>
  )
}
