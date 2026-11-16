package provisioning

import "strings"

// Provisioners whose volumes only one node can mount; the pod is pinned for
// life. minikube and Docker Desktop hostpath are included so local clusters
// classify honestly.
var nodeLocalProvisioners = setOf(
	"zfs.csi.openebs.io", "topolvm.io", "topolvm.cybozu.com", "openebs.io/local", "local.csi.openebs.io",
	"rancher.io/local-path", "kubernetes.io/no-provisioner", "k8s.io/minikube-hostpath", "docker.io/hostpath",
)

// Provisioners whose volumes any node in the same zone can mount.
var zonalProvisioners = setOf(
	"ebs.csi.aws.com", "kubernetes.io/aws-ebs", "disk.csi.azure.com", "pd.csi.storage.gke.io",
	"kubernetes.io/gce-pd", "cinder.csi.openstack.org", "csi.hetzner.cloud",
)

// Provisioners whose volumes any node can mount.
var clusterWideProvisioners = setOf(
	"rook-ceph.rbd.csi.ceph.com", "rook-ceph.cephfs.csi.ceph.com", "cephfs.csi.ceph.com", "rbd.csi.ceph.com",
	"driver.longhorn.io", "nfs.csi.k8s.io", "efs.csi.aws.com", "file.csi.azure.com",
)

func setOf(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, i := range items {
		m[i] = true
	}

	return m
}

func ClassifyTopology(provisioner string) StorageTopology {
	switch {
	case nodeLocalProvisioners[provisioner]:
		return NodeLocal
	case zonalProvisioners[provisioner]:
		return Zonal
	case clusterWideProvisioners[provisioner]:
		return ClusterWide
	default:
		return UnknownTopology
	}
}

var topologyClause = map[StorageTopology]string{
	NodeLocal:       "lives on one machine's disks, so a pod using it can only ever run on that machine",
	Zonal:           "lives in one zone, so a pod using it can only run on nodes in that zone",
	ClusterWide:     "can be mounted by any node, so a pod using it can be rescheduled anywhere",
	UnknownTopology: "has an unrecognised provisioner, so we cannot tell whether the volume can move",
}

func impliesClause(topology StorageTopology, reclaimPolicy string, allowExpansion bool, bindingMode string) string {
	parts := []string{topologyClause[topology]}
	if reclaimPolicy == "Retain" {
		parts = append(parts, "keeps the data after you delete the database")
	}
	if !allowExpansion {
		parts = append(parts, "cannot be resized later")
	}
	// Immediate binding on node-local storage is the trap: the volume can be
	// created on a node the pod is then not schedulable to.
	if topology == NodeLocal && bindingMode == "Immediate" {
		parts = append(parts, "binds before a pod is scheduled, so the volume can land on a node the pod cannot use")
	}

	return strings.Join(parts, "; ")
}

// StorageClassInput is what the storage fact reads from a StorageClass.
type StorageClassInput struct {
	Name              string
	Provisioner       string
	ReclaimPolicy     string
	VolumeBindingMode string
	AllowExpansion    bool
	IsDefault         bool
	Description       *string
}

// ToStorageClassFact applies the API defaults (reclaim Delete, binding
// Immediate) and reports false for a class without a name or provisioner.
func ToStorageClassFact(in StorageClassInput) (StorageClassFact, bool) {
	if in.Name == "" || in.Provisioner == "" {
		return StorageClassFact{}, false
	}
	topology := ClassifyTopology(in.Provisioner)
	binding := "Immediate"
	if in.VolumeBindingMode == "WaitForFirstConsumer" {
		binding = "WaitForFirstConsumer"
	}
	reclaim := "Delete"
	if in.ReclaimPolicy == "Retain" || in.ReclaimPolicy == "Recycle" {
		reclaim = in.ReclaimPolicy
	}

	return StorageClassFact{
		Name:           in.Name,
		Provisioner:    in.Provisioner,
		IsDefault:      in.IsDefault,
		BindingMode:    binding,
		AllowExpansion: in.AllowExpansion,
		ReclaimPolicy:  reclaim,
		Topology:       topology,
		Implies:        impliesClause(topology, reclaim, in.AllowExpansion, binding),
		ReplicaSafe:    topology == ClusterWide || topology == Zonal,
		Description:    in.Description,
	}, true
}
