import PageHeader from "../components/page-header"
import PageLoading from "../components/page-loading"

const TITLE = "Topmost Owners"
const SUBTITLE = "Controllers at the root of each workload subtree"
const LOADING = "workloads"

export default function Loading() {
  return <PageLoading header={<PageHeader title={TITLE} subtitle={SUBTITLE} />} loading={LOADING} />
}
