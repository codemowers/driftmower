export default function NetworkSummary({
  name,
  peerTotal,
  inboundCount,
  externalTotal,
  portTotal,
}: {
  name: string
  peerTotal: number
  inboundCount: number
  externalTotal: number
  portTotal: number
}) {
  if (peerTotal + inboundCount + externalTotal + portTotal === 0) return null
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      <span className="font-mono text-foreground">{name}</span>
      {" talks to "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{peerTotal}</strong>
      {peerTotal === 1 ? " in-cluster peer, " : " in-cluster peers, "}
      {"accepts "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{inboundCount}</strong>
      {inboundCount === 1 ? " inbound client, " : " inbound clients, "}
      {externalTotal > 0 && (
        <>
          {"reaches "}
          <strong className="font-mono font-semibold tabular-nums text-foreground">{externalTotal}</strong>
          {externalTotal === 1 ? " external endpoint, " : " external endpoints, "}
        </>
      )}
      {"and exposes "}
      <strong className="font-mono font-semibold tabular-nums text-foreground">{portTotal}</strong>
      {portTotal === 1 ? " socket." : " sockets."}
    </p>
  )
}
