"use client"

import { useEffect } from "react"
import { useParams } from "next/navigation"
import { openNetstatdSession } from "@/lib/cluster/netstatd"

export default function WorkloadLayout({ children }: { children: React.ReactNode }) {
  const { uid } = useParams<{ uid: string }>()

  useEffect(() => {
    return openNetstatdSession(uid)
  }, [uid])

  return <>{children}</>
}
