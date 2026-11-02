"use client"

import { LogOut, User } from "lucide-react"
import type { SessionClaims } from "@/lib/auth/session"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils/cn"

type NavUserProps = {
  claims: SessionClaims
  isExpanded: boolean
}

export default function NavUser({ claims, isExpanded }: NavUserProps) {
  const label = claims.name || claims.email || claims.sub

  const trigger = (
    <PopoverTrigger
      className={cn(
        "flex cursor-pointer items-center rounded-md py-3 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        isExpanded ? "w-full gap-3 px-3" : "justify-center px-2 mx-0.5",
      )}
    >
      <User className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      {isExpanded && (
        <span className="truncate font-mono text-sm font-medium tracking-tighter">
          {label}
        </span>
      )}
    </PopoverTrigger>
  )

  return (
    <div
      className={cn(
        "flex w-full flex-col border-gray-200",
        isExpanded ? "border-t px-3 py-2" : "pb-2",
      )}
    >
      <Popover>
        {isExpanded ? (
          trigger
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{trigger}</TooltipTrigger>
            <TooltipContent side="right">
              <p className="font-medium">Signed in as {label}</p>
            </TooltipContent>
          </Tooltip>
        )}

        <PopoverContent
          side="right"
          align="end"
          sideOffset={isExpanded ? 20 : 10}
          collisionPadding={{ bottom: 16 }}
          className="w-80"
        >
          <div className="flex flex-col gap-0.5 px-1.5 pt-1">
            <p className="text-sm font-medium">{claims.name ?? claims.sub}</p>
            {claims.email && (
              <p className="truncate font-mono text-sm text-muted-foreground">
                {claims.email}
              </p>
            )}
            <p className="truncate font-mono text-sm text-muted-foreground">
              {claims.sub}
            </p>
          </div>

          <div className="border-t border-border" aria-hidden />

          <div className="flex flex-col gap-1 px-1.5">
            <h3 className="font-mono text-xs font-medium tracking-wide text-gray-400">
              Groups
            </h3>
            {claims.groups.length > 0 ? (
              claims.groups.map((group) => (
                <p key={group} className="truncate font-mono text-sm text-gray-800">
                  {group}
                </p>
              ))
            ) : (
              <p className="font-mono text-sm text-muted-foreground">none</p>
            )}
          </div>

          <div className="border-t border-border" aria-hidden />

          <form method="post" action="/api/auth/logout">
            <button
              type="submit"
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <LogOut className="size-4" aria-hidden />
              Sign out
            </button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  )
}
