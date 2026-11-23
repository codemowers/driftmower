"use client"
import { useStore } from "zustand"
import { downloadProgress } from "@/lib/http/downloads"
import { formatBytes } from "@/lib/utils/format-bytes"

export default function DownloadProgress() {
  const { receivedBytes, totalBytes, activeRequests } = useStore(downloadProgress)
  if (!activeRequests) return null
  return <span className="text-xs font-normal tabular-nums text-muted-foreground" title="Response bytes received; compressed network transfer size may differ.">
    {formatBytes(receivedBytes)}{totalBytes !== null && totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ""} received
  </span>
}
