"use client"

import { ChevronDown } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FOCUSES } from "../focus"
import type { FocusDefinition, FocusKey } from "../focus/types"

export default function FocusSelect({
  focus,
  onChange,
}: {
  focus: FocusDefinition
  onChange: (key: FocusKey) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold transition-colors outline-none hover:bg-gray-50 focus-visible:border-ring">
        <span className="grid text-left">
          {Object.values(FOCUSES).map(f => (
            <span key={f.key} aria-hidden className="invisible col-start-1 row-start-1 whitespace-nowrap">
              Focus: {f.label}
            </span>
          ))}
          <span className="col-start-1 row-start-1 whitespace-nowrap">
            <span className="text-muted-foreground">Focus: </span>
            <span className="text-foreground">{focus.label}</span>
          </span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-56 gap-0.5 p-2"
        onCloseAutoFocus={e => e.preventDefault()}
      >
        <DropdownMenuRadioGroup value={focus.key} onValueChange={value => onChange(value as FocusKey)}>
          {Object.values(FOCUSES).map(f => (
            <DropdownMenuRadioItem
              key={f.key}
              value={f.key}
              className="cursor-pointer py-2.5 pr-8 pl-3 font-medium text-foreground focus:bg-brand-bg/50 focus:text-foreground"
            >
              {f.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
