import { FileCode } from "lucide-react"
import { cn } from "@/lib/utils/cn"

export default function YamlLink({ uid, className }: { uid: string; className?: string }) {
  return (
    <a
      href={`/yaml/${uid}`}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-brand-text",
        className,
      )}
    >
      <FileCode className="size-3.5" />
      YAML
    </a>
  )
}
