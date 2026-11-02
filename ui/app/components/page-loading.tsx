import type { ReactNode } from "react"
import LoadingLine from "./loading-line"

export default function PageLoading({ header, loading }: { header?: ReactNode; loading?: string }) {
  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        {header}
        <LoadingLine loading={loading} />
      </main>
    </div>
  )
}
