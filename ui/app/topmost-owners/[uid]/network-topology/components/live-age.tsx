"use client"

import { useEffect, useState } from "react"

type Props = {
  timestamp: number | null
  prefix?: string
  className?: string
}

export default function LiveAge({ timestamp, prefix, className }: Props) {
  const [, force] = useState(0)

  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 1_000)
    return () => clearInterval(id)
  }, [])

  return (
    <span className={className}>
      {prefix}
      {format(timestamp)}
    </span>
  )
}

function format(timestamp: number | null): string {
  if (timestamp === null) return "—"
  const sec = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (sec < 1) return "just now"
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ago`
}
