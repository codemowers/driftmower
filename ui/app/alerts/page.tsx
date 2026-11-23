"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"
import PageHeader from "@/app/components/page-header"
import DetailLayout from "@/app/components/layout/detail-layout"
import AlertsCard from "@/app/components/findings/alerts-card"
import PrometheusAlerts from "@/app/cluster/components/prometheus-alerts"

// Every unsilenced firing alert, by affected resource, with the per-rule
// counts beside it.
export default function AlertsPage() {
  return (
    <Page>
      <PageHeader icon={ICONS.alerts} title="Alerts" subtitle="Firing Prometheus alerts across the cluster" />
      <DetailLayout main={<AlertsCard />} aside={<PrometheusAlerts />} />
    </Page>
  )
}
