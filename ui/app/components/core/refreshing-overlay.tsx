"use client"

import { useEffect, useState } from "react";
import { Check, Radar } from "lucide-react";
import { useClusterState } from "@/lib/cluster/cluster-state";
import type { AnalysisProgress, AnalysisStep } from "@/lib/cluster/refresh-state";
import { cn } from "@/lib/utils/cn";
import DriftmowerLogo from "./driftmower-logo";

const STEPS: { key: AnalysisStep; label: string }[] = [
    { key: "versions", label: "Finding containers and versions" },
    { key: "saving", label: "Saving report" },
    { key: "images", label: "Reading image details" },
    { key: "loading", label: "Loading results" },
];

const CLOCK_TICK_MS = 1000;
const ELAPSED_VISIBLE_AFTER_MS = 10_000;

type StepState = "done" | "active" | "todo";

export default function RefreshingOverlay() {
    const isLoading = useClusterState(state => state.isLoading);
    const analysis = useClusterState(state => state.analysis);
    const now = useClock(isLoading);

    if (!isLoading || !analysis) return null;

    const activeIndex = STEPS.findIndex(step => step.key === analysis.step);

    return (
        <div className="fixed inset-0 z-[5000] flex flex-col items-center justify-center bg-muted px-4">
            <div className="fixed top-4.5 left-5">
                <DriftmowerLogo />
            </div>

            <div className="mb-15 flex w-full max-w-[560px] flex-col gap-3.5 rounded-lg border border-border bg-background px-7 pt-6 pb-4 text-foreground">
                <div className="flex items-center gap-2">
                    <Radar className="size-6 shrink-0 text-brand-icon" aria-hidden />
                    <h1 className="flex-1 text-[20px] font-semibold" aria-live="polite">Analysing cluster</h1>
                    <span className="font-mono text-xs text-muted-foreground">{`Step ${activeIndex + 1} of ${STEPS.length}`}</span>
                </div>

                <ol className="flex flex-col divide-y divide-border">
                    {STEPS.map((step, index) => {
                        const state: StepState = index < activeIndex ? "done" : index === activeIndex ? "active" : "todo";
                        const meta = state === "done"
                            ? doneMeta(step.key, analysis)
                            : state === "active" ? activeMeta(analysis, now) : "";
                        return (
                            <li key={step.key} className="grid grid-cols-[22px_1fr_auto] items-center gap-x-2.5 gap-y-2.5 py-2.5">
                                <StepMarker state={state} />
                                <span className={cn("min-w-0 font-medium", state === "todo" && "font-normal text-muted-foreground")}>
                                    {step.label}
                                </span>
                                <span className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">{meta}</span>
                                {state === "active" && (
                                    <div className="col-span-2 col-start-2 flex h-11 min-w-0 flex-col gap-2">
                                        <StepBody analysis={analysis} />
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
}

function useClock(running: boolean): number {
    const [now, setNow] = useState(0);
    useEffect(() => {
        if (!running) return;
        const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
        return () => clearInterval(id);
    }, [running]);
    return now;
}

function activeMeta(analysis: AnalysisProgress, now: number): string {
    const elapsedMs = Math.max(0, now - analysis.stepStartedAt);
    if (analysis.step !== "saving" && elapsedMs <= ELAPSED_VISIBLE_AFTER_MS) return "";
    return `${Math.floor(elapsedMs / 1000)} s`;
}

function doneMeta(step: AnalysisStep, analysis: AnalysisProgress): string {
    if (step === "versions") {
        const containers = analysis.containerCount != null ? `${analysis.containerCount} containers` : "";
        const images = analysis.tags ? `${analysis.tags.total} images` : "";
        return [containers, images].filter(Boolean).join(" · ");
    }
    if (step === "images") return `${analysis.imagesTotal} images read`;
    return "";
}

function StepMarker({ state }: { state: StepState }) {
    if (state === "done") {
        return (
            <span role="img" aria-label="Done" className="grid size-[18px] place-items-center rounded-full bg-brand-bg text-brand">
                <Check className="size-3" strokeWidth={3} aria-hidden />
            </span>
        );
    }
    if (state === "active") {
        return (
            <span
                role="img"
                aria-label="In progress"
                className="size-[18px] animate-spin rounded-full border-2 border-border border-t-brand motion-reduce:animate-none motion-reduce:border-brand"
            />
        );
    }
    return <span role="img" aria-label="Not started" className="size-[18px] rounded-full border-[1.5px] border-border" />;
}

function StepBody({ analysis }: { analysis: AnalysisProgress }) {
    if (analysis.step === "versions") {
        const { tags, containerCount } = analysis;
        if (!tags) {
            const caption = containerCount != null ? `Found ${containerCount} containers` : "Looking for running containers";
            return (
                <>
                    <Caption left={caption} />
                    <ProgressBar fraction={0} />
                </>
            );
        }
        return (
            <>
                <Caption left={tags.image} right={`${tags.index} / ${tags.total}`} mono />
                <ProgressBar fraction={tags.index / tags.total} />
            </>
        );
    }
    if (analysis.step === "saving") return <Caption left="Waiting for the backend to save the report" />;
    if (analysis.step === "images") {
        if (analysis.imagesTotal === 0) {
            return (
                <>
                    <Caption left="Preparing image list" />
                    <div className="h-2 w-full overflow-hidden rounded-full bg-border">
                        <div className="h-full w-full animate-pulse rounded-full bg-brand/40 motion-reduce:animate-none" />
                    </div>
                </>
            );
        }
        return (
            <>
                <Caption left="Images" right={`${analysis.imagesRead} / ${analysis.imagesTotal}`} />
                <ProgressBar fraction={analysis.imagesRead / analysis.imagesTotal} />
            </>
        );
    }
    return <Caption left="Downloading the report" />;
}

function Caption({ left, right, mono }: { left: string; right?: string; mono?: boolean }) {
    return (
        <div className="flex justify-between gap-3 text-sm text-muted-foreground">
            <span className={cn("min-w-0 truncate", mono && "font-mono text-[13px]")}>{left}</span>
            {right && <span className="shrink-0 tabular-nums">{right}</span>}
        </div>
    );
}

function ProgressBar({ fraction }: { fraction: number }) {
    const percent = Math.max(0, Math.min(1, fraction)) * 100;
    return (
        <div className="h-2 w-full overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-brand transition-[width] duration-150" style={{ width: `${percent}%` }} />
        </div>
    );
}
