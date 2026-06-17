"use client"

import { useEffect } from "react"
import { useParams } from "next/navigation"
import { openNetstatdSession, resetNetstatdStable } from "@/lib/cluster/netstatd"
import { useWorkloadLivePrewarm } from "./components/use-workload-live-prewarm"

export default function WorkloadLayout({ children }: { children: React.ReactNode }) {
  const { uid } = useParams<{ uid: string }>()

  useEffect(() => {
    resetNetstatdStable(uid)
    return openNetstatdSession(uid)
  }, [uid])

  useWorkloadLivePrewarm(uid)

  return <>{children}</>
}
