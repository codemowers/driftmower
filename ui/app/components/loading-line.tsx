import { LoaderCircle } from "lucide-react"

export default function LoadingLine({ loading }: { loading?: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-sm text-muted-foreground animate-in fade-in delay-700 fill-mode-both motion-reduce:animation-duration-0"
    >
      <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      {loading ? `Loading ${loading}…` : "Loading…"}
    </p>
  )
}
