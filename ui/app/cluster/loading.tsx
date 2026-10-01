import PageHeader from "../components/page-header"
import PageLoading from "../components/page-loading"
import ClusterScopePill from "../components/cluster-scope-pill"

const TITLE = "Cluster"
const SUBTITLE = "Nodes and Kubernetes support lifecycle"
const LOADING = "nodes"

export default function Loading() {
  return <PageLoading header={<PageHeader title={TITLE} subtitle={SUBTITLE} accessory={<ClusterScopePill />} />} loading={LOADING} />
}
