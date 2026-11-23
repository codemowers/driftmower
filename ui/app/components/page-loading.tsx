import Page from "@/app/components/layout/page"
import type { ReactNode } from "react"
import LoadingLine from "./loading-line"

export default function PageLoading({ header, loading }: { header?: ReactNode; loading?: string }) {
  return (
    <>
      <Page>
        {header}
        <LoadingLine loading={loading} />
      </Page>
    </>
  )
}
