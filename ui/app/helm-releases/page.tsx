import PageHeader from "../components/page-header"

export default function HelmReleasesPage() {
  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">
        <PageHeader title="Helm Releases" subtitle="Installed charts and revision history" />
      </main>
    </div>
  )
}
