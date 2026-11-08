"use client"
import { forwardRef, type AnchorHTMLAttributes } from "react"
import { navigate } from "./navigation"
type Props = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean }
const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch: _prefetch, replace, scroll: _scroll, onClick, ...props }, ref) {
  return <a {...props} ref={ref} href={href} onClick={event => {
    onClick?.(event)
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !props.target && !props.download && new URL(href, location.href).origin === location.origin) { event.preventDefault(); navigate(href, replace) }
  }}/>
})
export default Link
