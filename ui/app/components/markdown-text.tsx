"use client"
import { safeSourceURL } from "@/lib/features/crawler/sources"

import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils/cn"


// Text that comes as Markdown: kubernetes.io/description annotations,
// advisory summaries and CVE titles. Raw HTML is not rendered, and links
// leave the dashboard.
export default function MarkdownText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 break-words [&_a]:text-brand-text [&_a]:underline [&_code]:rounded [&_code]:bg-gray-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_li]:ml-5 [&_ol]:list-decimal [&_p+p]:mt-1.5 [&_pre]:overflow-x-auto [&_ul]:list-disc", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={safeSourceURL(href)} target="_blank" rel="noreferrer">{children}</a> }}>
        {text}
      </Markdown>
    </div>
  )
}
