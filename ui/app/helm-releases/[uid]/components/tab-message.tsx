import { cn } from "@/lib/utils/cn"

type Props = {
  children: React.ReactNode
  tone?: "muted" | "error"
}

export default function TabMessage({ children, tone = "muted" }: Props) {
  return (
    <div className="flex min-h-[calc(100vh-11rem)] items-center justify-center rounded-xl border border-gray-200 bg-white">
      <p className={cn("text-sm", tone === "error" ? "text-status-major-label" : "text-muted-foreground")}>
        {children}
      </p>
    </div>
  )
}
