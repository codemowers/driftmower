"use client"
import { useState } from "react"
import { SUMMARY_WINDOWS } from "@/lib/features/drift-history/time-window"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"
import AlertsCard from "../components/findings/alerts-card"
import ScanCoverageHistory from "./components/scan-coverage-history"
import SecurityHistory from "./components/security-history"
import DriftBreakdown from "./components/drift-breakdown"
import TechnicalDebtEstimate from "./components/technical-debt-estimate"
import DriftOverTime from "./components/drift-over-time"
import MostOutdatedWorkloads from "./components/most-outdated-workloads"
import PageHeader from "../components/page-header"
import { reportReadiness } from "@/lib/cluster/report-readiness"
import { useCurrentDrift, useSignalHistory, useSignalCapabilities } from "@/lib/features/drift-history/use-signal-history"
import { currentSignal } from "@/lib/features/drift-history/signals"

export default function ExecutiveSummaryPage() {
  const [hours,setHours]=useState(168)
  const features=useSignalCapabilities()
  const drift=useCurrentDrift()
  const history=useSignalHistory("drift",hours)
  const signal=(name:string)=>currentSignal(drift.data,name)??0
  const counts={ok:signal("current"),patch:signal("patch"),minor:signal("minor"),major:signal("major"),behind:signal("behind"),unknown:signal("unknown")}
  const known=counts.ok+counts.patch+counts.minor+counts.major+counts.behind
  const readiness=reportReadiness({hasReport:!!drift.data?.series.some(series=>series.values.length>0),isFetchingReport:drift.loading,knownVersions:known,containers:known+counts.unknown})
  return <Page>
    <PageHeader icon={ICONS.summary} title="Executive Summary" actions={<select aria-label="Time window" value={hours} onChange={event=>setHours(Number(event.target.value))} className="rounded border bg-white px-2 py-1">{SUMMARY_WINDOWS.map(window=><option key={window.hours} value={window.hours}>{window.label}</option>)}</select>} />
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {drift.error&&<p role="alert" className="text-sm text-status-major-label">Container drift unavailable: {drift.error}</p>}
        <DriftBreakdown readiness={readiness} total={known+counts.unknown} behind={counts.behind} ok={counts.ok} patch={counts.patch} minor={counts.minor} major={counts.major}/>
      </div>
      <TechnicalDebtEstimate hours={hours}/>
    </div>
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <AlertsCard title="Top issues" limit={5}/>
      <MostOutdatedWorkloads/>
    </div>
    <div className={features.data?.scan_coverage?"grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]":""}>
      {features.data?.scan_coverage&&<ScanCoverageHistory hours={hours}/>}
      <DriftOverTime state={history} hours={hours}/>
    </div>
    <SecurityHistory hours={hours} features={features}/>
  </Page>
}
