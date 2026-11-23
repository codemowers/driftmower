"use client"

import { useFeatureFlags } from "./feature-flags-init"
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
  const features = useFeatureFlags()
  const path = href.split("?")[0]
  const disabled = (/^\/(users|groups)(?:\/|$)/.test(path) && !features.oidcUsers) || (/^\/vulnerabilities(?:\/|$)/.test(path) && !features.imageScans) || (path === "/advisories" && !features.advisories)
  const prefetchPage = usePagePrefetch()
  const prefetch = () => prefetchPage(href)

  if (disabled) return <span className={props.className} title={props.title}>{props.children}</span>

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
