import PageHeader from "../components/page-header"
import PageLoading from "../components/page-loading"

const TITLE = "Applications"
const SUBTITLE = "Applications you can reach, and the other hosts in your namespaces"
const LOADING = "applications"

export default function Loading() {
  return <PageLoading header={<PageHeader title={TITLE} subtitle={SUBTITLE} />} loading={LOADING} />
}
