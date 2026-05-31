"use client"

import { Container, Radar } from "lucide-react";
import { useClusterState } from "@/lib/cluster/cluster-state";
import DriftmowerLogo from "./driftmower-logo";

export default function RefreshingOverlay() {
    const { isLoading, socketProgress, containerCount } = useClusterState();
    const stage = socketProgress?.stage ?? null;
    const curIndex = socketProgress?.index ?? null;
    const total = socketProgress?.total ?? null;
    const curImage = socketProgress?.image ?? null;
    const progressPercent = curIndex != null && total != null && total > 0
        ? Math.round((curIndex / total) * 100)
        : 0;

    return isLoading ? (
        <div className="flex flex-col items-center justify-center w-full h-full bg-gray-50 fixed inset-0 z-[5000]">
            <div className="fixed top-4.5 left-5">
                <DriftmowerLogo />
            </div>

            <div className="flex flex-col gap-5 mb-15 border border-gray-200 shadow-sm bg-white rounded-lg w-[600px] p-8 text-black">
                {stage && stage == "analysis_complete" ? (
                    <>
                        <h1 className="text-[20px] font-semibold">Analysis complete (Loading results)</h1>
                    </>
                ) : (
                    <>
                    <div className="flex items-center gap-2">
                        <Radar className="size-6 shrink-0 text-brand-icon" aria-hidden />
                        <h1 className="text-[20px] font-semibold">Analysing cluster...</h1>
                    </div>

                    {containerCount && (
                        <div className="flex items-center gap-1 bg-brand-bg text-brand-text rounded-md px-3 py-2.5 text-sm">
                            <Container className="size-5 shrink-0" aria-hidden />
                            <span>{`Found ${containerCount} containers. Fetching image metadata...`}</span>
                        </div>
                    )}

                    {curImage && (
                        <div className="flex flex-col w-full gap-1.5">
                            <div className="flex w-full items-center justify-between text-sm text-muted-foreground">
                                <p className="truncate mr-4">{curImage}</p>
                                <p className="shrink-0">{`${curIndex} / ${total}`}</p>
                            </div>
                            <div className="w-full h-2 bg-gray-100 rounded-full">
                                <div className="h-full bg-brand rounded-full" style={{ width: `${progressPercent}%` }} />
                            </div>
                        </div>
                    )}
                    </>
                )}
            </div>
        </div>
    ) : (
        null
    );
}
