import { GitCompareArrows } from "lucide-react"

export default function DriftmowerLogo() {
    return (
        <div className="flex items-center gap-1">
            <GitCompareArrows className="size-6 text-brand" aria-hidden />
            <h1 className="font-mono text-xl font-semibold tracking-tighter text-brand">
                Driftmower
            </h1>
        </div>
    )
}
