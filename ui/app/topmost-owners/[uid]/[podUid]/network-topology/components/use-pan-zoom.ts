"use client"

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import type { Rect } from "./graph-layout"

const BOTTOM_PADDING = 24
const MIN_SCALE = 0.2
const MAX_SCALE = 2
const ZOOM_STEP = 1.3
const FIT_PADDING = 60
const FIT_MAX = 1
const READABLE_MIN = 0.55

export type Transform = { tx: number; ty: number; scale: number }
export type Size = { w: number; h: number }

const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))

export function usePanZoom(bbox: Rect, ready: boolean) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ w: 0, h: 0 })
  const sizeRef = useRef(size)
  useEffect(() => {
    sizeRef.current = size
  }, [size])
  const [transform, setTransform] = useState<Transform>({ tx: 0, ty: 0, scale: 1 })
  const fittedRef = useRef(false)

  const fit = useCallback(() => {
    const { minX, minY, maxX, maxY } = bbox
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const { w, h } = sizeRef.current
    if (w === 0 || h === 0) return
    const computed = Math.min((w - FIT_PADDING * 2) / bw, (h - FIT_PADDING * 2) / bh)
    const scale = Math.max(READABLE_MIN, Math.min(FIT_MAX, computed))
    setTransform({ tx: -((minX + maxX) / 2) * scale, ty: -((minY + maxY) / 2) * scale, scale })
  }, [bbox])

  useEffect(() => {
    if (fittedRef.current || size.w === 0 || !ready) return
    fittedRef.current = true
    fit()
  }, [fit, size.w, ready])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      const w = Math.floor(rect.width)
      const h = Math.max(0, Math.floor(window.innerHeight - rect.top - BOTTOM_PADDING))
      setSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const { w, h } = sizeRef.current
      setTransform(t => {
        const next = clampScale(t.scale * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP))
        const cx = w / 2
        const cy = h / 2
        const lx = (mx - cx - t.tx) / t.scale
        const ly = (my - cy - t.ty) / t.scale
        return { scale: next, tx: mx - cx - lx * next, ty: my - cy - ly * next }
      })
    }
    el.addEventListener("wheel", handler, { passive: false })
    return () => el.removeEventListener("wheel", handler)
  }, [])

  const panRef = useRef<{ x: number; y: number } | null>(null)
  const panHandlers = {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      panRef.current = { x: e.clientX, y: e.clientY }
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (!panRef.current) return
      const dx = e.clientX - panRef.current.x
      const dy = e.clientY - panRef.current.y
      panRef.current = { x: e.clientX, y: e.clientY }
      setTransform(t => ({ ...t, tx: t.tx + dx, ty: t.ty + dy }))
    },
    onPointerUp: () => {
      panRef.current = null
    },
    onPointerLeave: () => {
      panRef.current = null
    },
  }

  const zoomIn = () => setTransform(t => ({ ...t, scale: clampScale(t.scale * ZOOM_STEP) }))
  const zoomOut = () => setTransform(t => ({ ...t, scale: clampScale(t.scale / ZOOM_STEP) }))

  return { containerRef, size, transform, fit, zoomIn, zoomOut, panHandlers }
}
