"use client"

import { useEffect } from "react"
import { useParams } from "next/navigation"
import { openNetstatdSession, resetNetstatdStable } from "@/lib/features/netstatd"

export default function WorkloadLayout({ children }: { children: React.ReactNode }) {
  const { uid } = useParams<{ uid: string }>()

  useEffect(() => {
    resetNetstatdStable(uid)
    return openNetstatdSession(uid)
  }, [uid])

  return <>{children}</>
}
