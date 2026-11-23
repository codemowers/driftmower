"use client"

import { useState } from "react"
import { LoaderCircle, Trash2 } from "lucide-react"
import Card from "@/app/components/layout/card"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { callTool } from "@/browser/connection"

const EXPLANATION = "If applicable, the Pod's controller will attempt to create a replacement Pod. Standalone Pods are not recreated automatically."

export default function DeletePodAction({ namespace, name, uid }: { namespace: string; name: string; uid: string }) {
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string>()
  async function remove() {
    if (!window.confirm(`Delete Pod ${namespace}/${name}?\n\n${EXPLANATION}`)) return
    setBusy(true)
    setError(undefined)
    try {
      await callTool("terminate_pod", { namespace, name, uid })
      setAccepted(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return <Card title="Actions">
    <Tooltip><TooltipTrigger asChild><Button className="w-fit" variant="outline" disabled={busy || accepted} onClick={() => void remove()}>
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
      {accepted ? "Deletion requested" : "Delete"}
    </Button></TooltipTrigger><TooltipContent className="max-w-xs">{EXPLANATION}</TooltipContent></Tooltip>
    {error && <p role="alert" className="text-sm text-status-major-label">Pod deletion failed: {error}</p>}
  </Card>
}
