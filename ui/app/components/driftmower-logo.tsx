import { GitCompareArrows } from "lucide-react"

export default function DriftmowerLogo() {
    return (
        <div className="flex items-center gap-1">
            <GitCompareArrows className="size-6 text-brand" aria-hidden />
            <h1 className="relative inline-block font-mono text-xl font-semibold tracking-tighter text-brand">
                Driftmower
                <span
                    className="pointer-events-none absolute left-full top-1/4 ml-1 -translate-y-1/2 whitespace-nowrap text-xs font-mono font-italic text-gray-400"
                    aria-hidden
                >
                    MVP
                </span>
            </h1>
        </div>
    )
}
