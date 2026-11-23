import type { LucideIcon } from "lucide-react"

// The single icon a page header carries.
export default function HeaderIcon({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-brand-icon" aria-label={label}>
      <Icon className="size-6" aria-hidden />
    </div>
  )
}
