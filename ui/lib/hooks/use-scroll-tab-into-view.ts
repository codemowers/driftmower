"use client"

import { useEffect, useRef } from "react"

const PIN_DURATION_MS = 600
const BOTTOM_THRESHOLD_PX = 24

function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

export function useScrollTabIntoView(active: string) {
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(false)

  useEffect(() => {
    if (!pendingRef.current) return
    pendingRef.current = false

    const scroller = getScrollParent(rootRef.current)
    const content = scroller?.firstElementChild
    if (!scroller || !content) return

    const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    if (distanceFromBottom < BOTTOM_THRESHOLD_PX) return

    const pinToBottom = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })
    pinToBottom()

    const observer = new ResizeObserver(pinToBottom)
    observer.observe(content)
    const stop = setTimeout(() => observer.disconnect(), PIN_DURATION_MS)

    return () => {
      observer.disconnect()
      clearTimeout(stop)
    }
  }, [active])

  function requestScroll() {
    pendingRef.current = true
  }

  return { rootRef, requestScroll }
}
