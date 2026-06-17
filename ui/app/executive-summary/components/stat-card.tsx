import { cn } from "@/lib/utils/cn"
export type StatAccent = "ok" | "patch" | "minor" | "major" | "brand"

export type StatValueTone =
    | "ok"
    | "patch"
    | "minor"
    | "major"
    | "brand"
    | "muted"

export type StatCardProps = {
    value: string | number
    accent: StatAccent
    valueTone: StatValueTone
    textTone?: StatValueTone
    label?: string
    hint?: string
}

export default function StatCard({
    value,
    accent,
    valueTone,
    textTone,
    label,
    hint,
}: StatCardProps) {
    const bg: Record<StatAccent, string> = {
        ok: "bg-status-ok-bg border-status-ok",
        patch: "bg-status-patch-bg border-status-patch",
        minor: "bg-status-minor-bg border-status-minor",
        major: "bg-status-major-bg border-status-major",
        brand: "bg-brand-bg border-brand",
    }

    const text: Record<StatValueTone, string> = {
        ok: "text-status-ok-label",
        patch: "text-status-patch-label",
        minor: "text-status-minor-label",
        major: "text-status-major-label",
        brand: "text-brand-label",
        muted: "text-muted-foreground",
    }

    return (
        <div className={cn(
            "flex min-w-0 flex-col gap-1 rounded-3xl border-t-4 px-6 py-6.5",
            bg[accent],
        )}>
            {label && (
                <p className={cn("text-xs font-semibold uppercase tracking-wider", text[textTone ?? valueTone])}>
                    {label}
                </p>
            )}
            <p className={cn("text-4xl font-semibold tabular-nums", text[valueTone])}>
                {value}
            </p>
            {hint && (
                <p className={cn("text-sm", text[textTone ?? valueTone])}>
                    {hint}
                </p>
            )}
        </div>
    );
}
