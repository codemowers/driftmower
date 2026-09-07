"use client"

import { useEffect, useMemo, useState } from "react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useNetstatd, aggregate, buildPodGraph } from "@/lib/features/netstatd"
import { buildLayout, edgeEndpoints, elbowPath } from "./graph-layout"
import { usePanZoom } from "./use-pan-zoom"
import TopologyNode from "./topology-node"
import GraphControls from "./graph-controls"

type Props = {
  podName: string
  podNamespace: string
  podIPs: string[]
}

const ARROW = 10
const ARROW_K = 2.5
const ARROW_ZMAX = 2.5
const ARROW_OVERLAP = 0.75

const EDGE_W_MIN = 1.5
const EDGE_W_MAX = 6
const COLOR_FLOOR = 0.3
const COLOR_CAP = 0.85

const FRESH_MS = 30_000
const IDLE_MS = 90_000
const EDGE_FLOOR = 0.3

export default function NetworkTopologyGraph({ podName, podNamespace, podIPs }: Props) {
  const clusterResources = useClusterState(s => s.clusterResources)
  const aggregates = useNetstatd(s => s.aggregates)
  const hosts = useNetstatd(s => s.hosts)

  const podIPSet = useMemo(() => new Set(podIPs), [podIPs])
  const graph = useMemo(
    () => buildPodGraph(aggregate(aggregates, clusterResources, hosts, podIPSet), podName, podNamespace),
    [aggregates, clusterResources, hosts, podIPSet, podName, podNamespace],
  )

  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map())
  const [expandedPeers, setExpandedPeers] = useState<Set<string>>(new Set())
  const [, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2500)
    return () => clearInterval(id)
  }, [])

  const layout = useMemo(() => buildLayout(graph, overrides, expandedPeers), [graph, overrides, expandedPeers])
  const { orderedEdges, maxEdgeCount } = useMemo(() => {
    const ordered = [...layout.edges].sort((a, b) => a.count - b.count)
    return { orderedEdges: ordered, maxEdgeCount: ordered.length ? ordered[ordered.length - 1].count : 0 }
  }, [layout.edges])

  const { containerRef, size, transform, fit, zoomIn, zoomOut, panHandlers } = usePanZoom(
    layout.bbox,
    layout.items.length > 0,
  )

  const toggleNamespace = (key: string, collapsed: boolean) =>
    setOverrides(prev => new Map(prev).set(key, !collapsed))

  const togglePeer = (key: string) =>
    setExpandedPeers(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const cx = size.w / 2
  const cy = size.h / 2

  return (
    <div
      ref={containerRef}
      className="relative w-full touch-none overflow-hidden rounded-lg border border-border"
      style={{
        height: size.h || undefined,
        backgroundImage: "radial-gradient(var(--color-border) 1px, transparent 1px)",
        backgroundSize: "16px 16px",
      }}
      {...panHandlers}
    >
      {size.w > 0 && (
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${cx + transform.tx}px, ${cy + transform.ty}px) scale(${transform.scale})` }}
        >
          <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
            {orderedEdges.map(edge => {
              const ep = edgeEndpoints(edge, layout)
              if (!ep) return null
              const opacity = edgeOpacity(edge.lastSeen)
              const t = maxEdgeCount > 0 ? Math.min(1, edge.count / maxEdgeCount) : 0
              const sw = edgeWidth(t)
              const color = edgeColor(t)
              const zoom = Math.min(ARROW_ZMAX, Math.max(1, transform.scale))
              const a = Math.min(
                (Math.max(ARROW, sw * ARROW_K) * zoom) / transform.scale,
                (ep.tx - ep.sx) * 0.4,
              )
              return (
                <g key={edge.key} stroke={color} fill={color} opacity={opacity}>
                  <path
                    d={elbowPath({ ...ep, tx: ep.tx - a * ARROW_OVERLAP })}
                    fill="none"
                    strokeWidth={sw}
                    vectorEffect="non-scaling-stroke"
                  />
                  <polygon
                    points={`${ep.tx},${ep.ty} ${ep.tx - a},${ep.ty - a * 0.5} ${ep.tx - a},${ep.ty + a * 0.5}`}
                    stroke="none"
                  />
                </g>
              )
            })}
          </svg>

          {layout.items.map(item => {
            const pos = layout.positions.get(item.key)
            const sz = layout.sizes.get(item.key)
            if (!pos || !sz) return null
            const isNamespace = item.node.kind === "namespace"
            const isPeer = item.node.kind !== "pod" && !isNamespace
            const hasPorts = isPeer && item.node.ports.length > 0
            const onToggle = isNamespace
              ? () => toggleNamespace(item.key, item.collapsed)
              : hasPorts
                ? () => togglePeer(item.key)
                : undefined
            return (
              <div
                key={item.key}
                className="absolute"
                style={{ left: pos.x, top: pos.y, width: sz.w, height: sz.h, transform: "translate(-50%, -50%)" }}
              >
                <TopologyNode
                  node={item.node}
                  side={item.side}
                  collapsed={isNamespace ? item.collapsed : undefined}
                  expanded={isPeer ? expandedPeers.has(item.key) : undefined}
                  onToggle={onToggle}
                />
              </div>
            )
          })}
        </div>
      )}

      <GraphControls onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fit} />
    </div>
  )
}

function edgeOpacity(lastSeen: number): number {
  const age = lastSeen > 0 ? Date.now() - lastSeen : Infinity
  const factor = age <= FRESH_MS ? 1 : age >= IDLE_MS ? 0 : 1 - (age - FRESH_MS) / (IDLE_MS - FRESH_MS)
  return EDGE_FLOOR + (1 - EDGE_FLOOR) * factor
}

function edgeWidth(t: number): number {
  return EDGE_W_MIN + (EDGE_W_MAX - EDGE_W_MIN) * t
}

function edgeColor(t: number): string {
  const mix = Math.max(0, (t - COLOR_FLOOR) / (1 - COLOR_FLOOR)) * COLOR_CAP
  return `color-mix(in oklab, var(--color-brand) ${Math.round(mix * 100)}%, var(--color-muted-foreground))`
}
