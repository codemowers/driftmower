"use client"

import { useState } from "react"
import { AlertTriangle, RefreshCw, X } from "lucide-react"
import MissingComponents from "@/app/components/missing-components"

// Keep notices out of document flow so refreshes never move the dashboard.
export default function DashboardNotices({ messages, missingComponents }: {
  messages: (string | null | undefined)[]
  missingComponents: string[]
}) {
  const [dismissed, setDismissed] = useState("")
  const notices = [...new Set([
    ...messages,
    ...missingComponents.map(name => `${name} is not installed`),
  ].flatMap(message => message?.trim() ? [message.trim()] : []))]
  const signature = JSON.stringify(notices)

  return <>
    <button
      type="button"
      aria-label="Refresh all data"
      title="Refresh all data and reconnect"
      onClick={() => location.reload()}
      className="fixed right-4 top-4 z-40 rounded-lg border bg-white p-2 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground"
    >
      <RefreshCw className="size-5" aria-hidden />
    </button>
    {notices.length > 0 && dismissed !== signature && (
      <aside role="status" aria-live="polite" className="fixed left-4 right-16 top-4 z-40 mx-auto max-h-[50vh] max-w-3xl overflow-auto rounded-lg border border-amber-400 bg-amber-100 text-sm text-amber-950 shadow-lg">
        <button
          type="button"
          aria-label="Dismiss notices"
          onClick={() => setDismissed(signature)}
          className="absolute right-2 top-2 rounded p-1 hover:bg-amber-200"
        >
          <X className="size-4" aria-hidden />
        </button>
        <details>
          <summary className="cursor-pointer py-3 pl-4 pr-10">
            <span className="ml-1 inline-flex max-w-[90%] items-center gap-2 align-middle">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{notices[0]}{notices.length > 1 ? ` (+${notices.length - 1} more)` : ""}</span>
            </span>
          </summary>
          <div className="space-y-2 border-t border-amber-300 p-4">
            {notices.map(message => <p key={message} className="break-words">{message}</p>)}
            <MissingComponents components={missingComponents} />
          </div>
        </details>
      </aside>
    )}
  </>
}
