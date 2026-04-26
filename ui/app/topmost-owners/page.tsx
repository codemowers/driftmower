import PageHeader from "../components/page-header"

export default function TopmostOwnersPage() {
  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">
        <PageHeader title="Topmost Owners" subtitle="Controllers at the root of each workload subtree" />
      </main>
    </div>
  )
}
