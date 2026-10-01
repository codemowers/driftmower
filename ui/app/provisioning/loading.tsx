import PageHeader from "../components/page-header"
import PageLoading from "../components/page-loading"
import ClusterScopePill from "../components/cluster-scope-pill"

const TITLE = "Provisioning"
const SUBTITLE = "What this cluster will let you deploy, and the rules it enforces. Nothing here changes anything."
const LOADING = "cluster support"

export default function Loading() {
  return <PageLoading header={<PageHeader title={TITLE} subtitle={SUBTITLE} accessory={<ClusterScopePill />} />} loading={LOADING} />
}
