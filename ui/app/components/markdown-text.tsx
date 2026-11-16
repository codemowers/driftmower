"use client"

import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils/cn"

function safeURL(raw?: string) {
  try {
    const url = new URL(raw ?? "")
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

// Text that comes as Markdown: kubernetes.io/description annotations,
// advisory summaries and CVE titles. Raw HTML is not rendered, and links
// leave the dashboard.
export default function MarkdownText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 break-words [&_a]:text-brand-text [&_a]:underline [&_code]:rounded [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_li]:ml-5 [&_ol]:list-decimal [&_p+p]:mt-1.5 [&_pre]:overflow-x-auto [&_ul]:list-disc", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={safeURL(href)} target="_blank" rel="noreferrer">{children}</a> }}>
        {text}
      </Markdown>
    </div>
  )
}
