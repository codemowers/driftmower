import { cn } from "@/lib/utils/cn"

type Props = {
  title: string
  count: number
  emptyText: string
  height?: string
  children: React.ReactNode
}

export default function Section({
  title,
  count,
  emptyText,
  height = "h-80",
  children,
}: Props) {
  return (
    <section className={cn("flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white", height)}>
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2.5">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">
          <span className="uppercase">{title}</span>
          <span className="mx-2 text-muted-foreground/50">·</span>
          <span className="font-mono tabular-nums text-foreground">{count}</span>
        </p>
      </header>

      {count === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">{children}</div>
      )}
    </section>
  )
}
