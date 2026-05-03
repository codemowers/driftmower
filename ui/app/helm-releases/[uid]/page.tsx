"use client"

import { useParams } from "next/navigation"
import PageHeader from "@/app/components/page-header"

export default function HelmReleaseDetailPage() {
  const { uid } = useParams<{ uid: string }>()

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">
        <PageHeader title="Helm Release" subtitle={uid} />
      </main>
    </div>
  )
}
