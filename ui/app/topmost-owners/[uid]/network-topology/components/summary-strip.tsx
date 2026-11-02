type Props = {
  podCount?: number
  listeningCount: number
  inboundClientCount: number
  outboundInClusterCount: number
  externalCount: number
}

export default function SummaryStrip({
  podCount,
  listeningCount,
  inboundClientCount,
  outboundInClusterCount,
  externalCount,
}: Props) {
  const cells: { value: number; label: string }[] = [
    ...(podCount !== undefined ? [{ value: podCount, label: "pods" }] : []),
    { value: listeningCount,          label: "listening ports" },
    { value: inboundClientCount,      label: "inbound clients" },
    { value: outboundInClusterCount,  label: "outbound peers" },
    { value: externalCount,           label: "external endpoints" },
  ]

  const colsClass = cells.length === 5
    ? "sm:grid-cols-3 lg:grid-cols-5"
    : "sm:grid-cols-2 lg:grid-cols-4"

  return (
    <div className={`grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 ${colsClass}`}>
      {cells.map(c => (
        <div key={c.label} className="flex flex-col gap-1 bg-white px-5 py-4">
          <p className="font-mono text-2xl font-semibold tabular-nums text-foreground">
            {c.value.toLocaleString()}
          </p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {c.label}
          </p>
        </div>
      ))}
    </div>
  )
}
