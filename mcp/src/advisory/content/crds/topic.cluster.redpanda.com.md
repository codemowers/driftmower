# Kafka topics — Topic.cluster.redpanda.com

Qualified kind: `Topic.cluster.redpanda.com`. CRD: `topics.cluster.redpanda.com`. Example API version: `cluster.redpanda.com/v1alpha2`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

## Provisioning

Create the backing broker with `crds/redpanda.cluster.redpanda.com`. Declare application topics through the operator instead of relying on broker auto-creation.

```yaml
apiVersion: cluster.redpanda.com/v1alpha2
kind: Topic
metadata:
  name: example-images
spec:
  cluster:
    clusterRef:
      name: example-redpanda
  partitions: 3
  additionalConfig:
    cleanup.policy: compact
```

Partition count bounds consumer-group parallelism. Key related updates and deletes by the same stable entity ID so they route to the same partition. Consider the ordering implications before changing partition counts.

Compacted topics represent keyed state, not a complete historical event log. Produce tombstones for deletion and design projections to tolerate replay and repeated delivery. Compaction is asynchronous, and tombstones are subject to the broker's delete-retention settings; do not assume every deletion remains available forever to a long-offline consumer. For an event history, choose deliberate time/size retention instead of treating compaction as an audit log.

Give each independent projection its own consumer group and ACLs (`crds/user.cluster.redpanda.com`). Commit offsets only after processing and any required downstream publication succeeds. A failed job must remain uncommitted. Check topic reconciliation status, partition count and replication before treating the resource as ready. Keep maintenance/replay operations separate from ordinary application startup.
