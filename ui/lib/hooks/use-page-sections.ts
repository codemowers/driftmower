"use client"

import { useEffect, useRef } from "react"
import { create } from "zustand"

export type PageSection = { id: string; title: string }

type PageSectionsState = {
  // The route that published the sections, so the nav bar nests them under
  // the matching item and nowhere else.
  href: string | null
  sections: PageSection[]
  active: string | null
}

// Section list a page hands to the main nav bar, which renders it as
// sub-items of that page's entry.
export const usePageSectionsStore = create<PageSectionsState>(() => ({
  href: null,
  sections: [],
  active: null,
}))

export function setActivePageSection(id: string): void {
  usePageSectionsStore.setState({ active: id })
}

// Publishes `sections` for the nav bar while the calling page is mounted, and
// tracks which one is in view: the topmost section whose heading sits in the
// upper part of the scroll container. The page scrolls inside a layout div
// rather than the window, so the observer is rooted on the nearest scrolling
// ancestor.
export function usePageSections(href: string, sections: PageSection[]): void {
  // Callers build the list inline; key the effects on its content instead.
  const key = sections.map(s => `${s.id}\u0000${s.title}`).join("\u0001")
  const followedHash = useRef(false)

  useEffect(() => {
    const current = usePageSectionsStore.getState().active
    usePageSectionsStore.setState({
      href,
      sections,
      active: sections.some(s => s.id === current) ? current : (sections[0]?.id ?? null),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href, key])

  useEffect(
    () => () => usePageSectionsStore.setState({ href: null, sections: [], active: null }),
    [],
  )

  useEffect(() => {
    const targets = sections
      .map(s => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null)
    if (targets.length === 0) return

    // A deep link from another page lands before the sections render, so the
    // browser's own jump to the hash has nothing to hit. Redo it, once, when
    // they first exist.
    if (!followedHash.current) {
      followedHash.current = true
      const hash = decodeURIComponent(window.location.hash.slice(1))
      const linked = hash ? targets.find(t => t.id === hash) : undefined
      if (linked) {
        linked.scrollIntoView()
        setActivePageSection(linked.id)
      }
    }

    const root = scrollParent(targets[0])
    const visible = new Set<string>()

    const observer = new IntersectionObserver(
      records => {
        for (const r of records) {
          if (r.isIntersecting) visible.add(r.target.id)
          else visible.delete(r.target.id)
        }
        // Topmost visible heading wins, in document order.
        const next = sections.find(s => visible.has(s.id))
        if (next) setActivePageSection(next.id)
      },
      { root, rootMargin: "0px 0px -60% 0px", threshold: 0 },
    )
    targets.forEach(t => observer.observe(t))
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return node
  }
  return null
}
