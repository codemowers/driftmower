import PageHeader from "../components/page-header"
import PageLoading from "../components/page-loading"

const TITLE = "Sandboxes"
const SUBTITLE = "Your sandboxes and their kubeconfig snippets"
const LOADING = "sandboxes"

export default function Loading() {
  return <PageLoading header={<PageHeader title={TITLE} subtitle={SUBTITLE} />} loading={LOADING} />
}
