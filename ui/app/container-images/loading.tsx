import PageHeader from "../components/page-header"
import PageLoading from "../components/page-loading"

const TITLE = "Container Images"
const SUBTITLE = "Every unique image running in the cluster"
const LOADING = "images"

export default function Loading() {
  return <PageLoading header={<PageHeader title={TITLE} subtitle={SUBTITLE} />} loading={LOADING} />
}
