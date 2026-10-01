"use client"

import type { ComponentProps } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types"

export function usePagePrefetch(): (href: string) => void {
  const router = useRouter()
  return href => router.prefetch(href, { kind: PrefetchKind.FULL })
}

type Props = Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string }

export default function PrefetchLink({ href, onMouseEnter, onFocus, onTouchStart, ...props }: Props) {
  const prefetchPage = usePagePrefetch()
  const prefetch = () => prefetchPage(href)

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onMouseEnter={event => {
        prefetch()
        onMouseEnter?.(event)
      }}
      onFocus={event => {
        prefetch()
        onFocus?.(event)
      }}
      onTouchStart={event => {
        prefetch()
        onTouchStart?.(event)
      }}
    />
  )
}
