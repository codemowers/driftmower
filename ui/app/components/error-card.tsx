import type { ReactNode } from "react"
import { RefreshCw, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils/cn"

type Props = {
  tone: "error" | "update"
  title: string
  message: string
  error: Error & { digest?: string }
  children: ReactNode
}

export default function ErrorCard({ tone, title, message, error, children }: Props) {
  const Icon = tone === "error" ? TriangleAlert : RefreshCw
  const details = `${error.name}: ${error.message}${error.digest ? `\nDigest: ${error.digest}` : ""}`
  return (
    <section role="alert" className="flex w-full max-w-xl flex-col gap-5 rounded-xl border border-gray-200 bg-white p-7">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <Icon
            className={cn("size-5 shrink-0", tone === "error" ? "text-status-major-label" : "text-brand-icon")}
            aria-hidden
          />
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
      <details className="rounded-lg border border-gray-200 bg-gray-50">
        <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-muted-foreground">Details</summary>
        <pre className="whitespace-pre-wrap break-words px-3 pb-3 font-mono text-xs text-status-major-text">{details}</pre>
      </details>
      <div className="flex flex-wrap gap-2">{children}</div>
    </section>
  )
}
