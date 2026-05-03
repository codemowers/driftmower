"use client"

import { Button } from "@/components/ui/button"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { refreshState } from "@/lib/cluster/refresh-state"
import { useState } from "react"
import PageHeader from "../components/page-header"

export default function OidcApplicationsPage() {


  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">
      <PageHeader title="OIDC Applications" subtitle="Discovered applications" />


      </main>
    </div>
  )
}
