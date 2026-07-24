"use client"

import { ExternalLink, Users } from "lucide-react"
import CopyButton from "@/app/components/copy-button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { OidcApp } from "../hooks/use-oidc-applications"

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function initials(name: string) {
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 2)
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()
}

export default function OidcApplicationTile({ app }: { app: OidcApp }) {
  return (
    <div className="group relative flex items-center gap-4 rounded-lg border border-border bg-card px-5 py-6 transition-colors hover:border-brand/40 hover:bg-brand-bg/30 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-brand">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg font-mono text-base font-semibold tracking-tight text-brand-icon">
        {initials(app.name)}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <a
          href={app.url}
          target="_blank"
          rel="noreferrer"
          className="font-heading text-base font-semibold text-foreground after:absolute after:inset-0 focus-visible:outline-none"
        >
          {app.name}
        </a>

        <div className="flex min-w-0 items-center gap-1.5">
          <p className="truncate font-mono text-xs text-muted-foreground">{displayUrl(app.url)}</p>
          <CopyButton value={app.url} className="relative z-10 shrink-0" />
        </div>

        {app.description && (
          <div
            className="line-clamp-2 text-sm text-muted-foreground [&_a]:relative [&_a]:z-10 [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: app.description }}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 self-start">
        {app.groups.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Access via ${app.groups.join(", ")}`}
                className="relative z-10 text-muted-foreground transition-colors hover:text-brand-text"
              >
                <Users className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex flex-col gap-0.5">
                <span className="text-background/70">Access via:</span>
                {app.groups.map(group => (
                  <span key={group} className="font-mono">
                    {group}
                  </span>
                ))}
              </span>
            </TooltipContent>
          </Tooltip>
        )}
        <ExternalLink
          className="size-4 text-muted-foreground transition-colors group-hover:text-brand-text"
          aria-hidden
        />
      </div>
    </div>
  )
}
