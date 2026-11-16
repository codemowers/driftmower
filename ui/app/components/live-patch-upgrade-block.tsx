"use client"
import { useKubectlConnection } from "@/lib/hooks/use-kubectl"
import { scopeActionCommand } from "@/lib/kubernetes/contexts"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import CopyButton from "./copy-button"
import DocumentViewer from "./document-viewer"
import { textLines } from "@/lib/features/yaml/yaml-lines"
import { applyLivePatchUpgrade, previewLivePatchUpgrade, removeLivePatchUpgrade } from "@/lib/features/live-patch-upgrade/client"
import { APPS_KINDS, restartCommand } from "@/lib/features/live-patch-upgrade/image-ref"
import type { LivePatchUpgradeState } from "@/lib/features/live-patch-upgrade/use-live-patch-upgrade"
import type { LivePatchUpgradePreviewResponse, LivePatchUpgradeRequest, LivePatchUpgradeTarget } from "@/lib/features/live-patch-upgrade/types"
import type { DisplayRow } from "@/lib/features/actions/types"

type Props = { row: DisplayRow; target: LivePatchUpgradeTarget; state: LivePatchUpgradeState }

type WriteState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "removing" }
  | { status: "error"; message: string }

type PreviewState =
  | { status: "closed" }
  | { status: "loading" }
  | { status: "open"; preview: LivePatchUpgradePreviewResponse }
  | { status: "error"; message: string }

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function restartLabel(target: LivePatchUpgradeTarget): string {
  return APPS_KINDS.has(target.kind) ? `restarts ${target.kind} ${target.name}` : `recreates the pods of ${target.kind} ${target.name}`
}

export default function LivePatchUpgradeBlock({ row, target, state }: Props) {
  const connection = useKubectlConnection()
  const restart = scopeActionCommand(restartCommand(target), connection)
  const [write, setWrite] = useState<WriteState>({ status: "idle" })
  const [preview, setPreview] = useState<PreviewState>({ status: "closed" })
  const [copied, setCopied] = useState(false)

  const request: LivePatchUpgradeRequest = { facts: row.facts, target }
  const active = state.active !== null
  const busy = write.status === "applying" || write.status === "removing"
  const from = row.displayFrom
  const to = row.facts.to

  function clearErrors() {
    setWrite(w => (w.status === "error" ? { status: "idle" } : w))
    setPreview(p => (p.status === "error" ? { status: "closed" } : p))
  }

  async function loadPreview(): Promise<LivePatchUpgradePreviewResponse | null> {
    if (preview.status === "open") return preview.preview
    setPreview({ status: "loading" })
    try {
      const result = await previewLivePatchUpgrade(request)
      setPreview({ status: "open", preview: result })
      return result
    } catch (e) {
      setPreview({ status: "error", message: errorMessage(e) })
      return null
    }
  }

  function togglePreview() {
    clearErrors()
    if (preview.status === "open") setPreview({ status: "closed" })
    else void loadPreview()
  }

  async function copyManifest() {
    const result = await loadPreview()
    if (!result) return
    await navigator.clipboard.writeText(result.yaml)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function run(status: "applying" | "removing", action: (request: LivePatchUpgradeRequest) => Promise<void>) {
    clearErrors()
    setWrite({ status })
    try {
      await action(request)
      setWrite({ status: "idle" })
      if (status === "removing") setPreview({ status: "closed" })
    } catch (e) {
      setWrite({ status: "error", message: errorMessage(e) })
    }
  }

  const previewLabel = preview.status === "open" ? "Hide manifest" : active ? "View manifest" : "Preview manifest"

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-gray-200">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {active ? (
              <>
                <p className="text-[13.5px] font-semibold">Running pods are on {to}. The release is still on {from}.</p>
                <p className="text-[12.5px] text-muted-foreground">
                  The policy rewrites every new pod until the permanent fix below lands. Remove puts the pods back on {from}, which apps that migrated data on {to} may not survive.
                </p>
              </>
            ) : (
              <>
                <p className="text-[13.5px] font-semibold">Move the running pods to {to} now</p>
                <p className="text-[12.5px] text-muted-foreground">
                  Adds an admission policy that rewrites <code className="rounded bg-gray-100 px-1 font-mono text-xs">{row.facts.repository}:{from}</code> to {to} on new pods, then {restartLabel(target)}. The manager keeps declaring {from} until you run the permanent fix.
                </p>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={togglePreview} disabled={preview.status === "loading"}>
              {previewLabel}
            </Button>
            {active ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void run("removing", removeLivePatchUpgrade)} disabled={busy}>
                {write.status === "removing" ? "Removing" : "Remove temporary fix"}
              </Button>
            ) : state.canWrite ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void run("applying", applyLivePatchUpgrade)} disabled={busy}>
                {write.status === "applying" ? "Applying" : "Apply temporary fix"}
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => void copyManifest()} disabled={preview.status === "loading"}>
                {copied ? "Copied" : "Copy manifest"}
              </Button>
            )}
          </div>
        </div>
        {!active && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-200 px-4 py-2 text-xs text-muted-foreground">
            <span>Creates <span className="font-medium text-foreground">ConfigMap</span>, <span className="font-medium text-foreground">MutatingAdmissionPolicy</span> and <span className="font-medium text-foreground">Binding</span> scoped to {target.namespace}</span>
            <span className="first-letter:uppercase">{restartLabel(target)}</span>
          </div>
        )}
        {!active && !state.canWrite && state.blockedReason && (
          <p className="border-t border-gray-200 px-4 py-2 text-xs text-muted-foreground">
            Driftmower cannot apply this itself: <span className="font-mono text-foreground">{state.blockedReason}</span>
          </p>
        )}
        {!active && !state.canWrite && (
          <div className="flex items-center gap-3 border-t border-gray-200 px-4 py-2">
            <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">kubectl</span>
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12.5px] text-foreground">{restart}</code>
            <CopyButton value={restart} className="shrink-0" />
          </div>
        )}
      </div>

      {write.status === "error" && <p className="px-1 text-xs text-status-major-text">{write.message}</p>}
      {preview.status === "error" && <p className="px-1 text-xs text-status-major-text">Could not render the manifest: {preview.message}</p>}

      {preview.status === "open" && (
        <DocumentViewer
          lines={textLines(preview.preview.yaml)}
          filename={`${preview.preview.name}.yaml`}
          toolbar={<span className="min-w-0 truncate font-mono text-xs text-foreground">{preview.preview.name}.yaml</span>}
          paneClassName="h-auto max-h-96 min-h-0"
        />
      )}
    </div>
  )
}
