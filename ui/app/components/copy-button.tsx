"use client"

import { useState } from "react"
import { Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils/cn"

export default function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${value}`}
      className={cn("text-muted-foreground transition-colors", className)}
    >
      {copied
        ? <Check className="size-4" />
        : <Copy className="size-4 hover:text-foreground" />
      }
    </button>
  )
}

// A preformatted block with a copy button in its corner.
export function CopySnippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <span className="absolute right-3 top-2 z-10"><CopyButton value={text} /></span>
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 pr-10 font-mono text-xs text-foreground">{text}</pre>
    </div>
  )
}
