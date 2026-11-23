// The footer of a findings card that shows its first few rows.
export default function ShowMore({ total, limit, expanded, onToggle, noun }: { total: number; limit: number; expanded: boolean; onToggle: () => void; noun: string }) {
  if (total <= limit) return null
  return (
    <div className="border-t border-gray-100 px-5 py-3">
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="text-xs text-muted-foreground hover:text-foreground">
        {expanded ? `Show top ${limit} ${noun}` : `Show all ${total} ${noun}`}
      </button>
    </div>
  )
}
