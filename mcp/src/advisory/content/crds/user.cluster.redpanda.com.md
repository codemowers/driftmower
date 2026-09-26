# Kafka identities and ACLs — User.cluster.redpanda.com

Qualified kind: `User.cluster.redpanda.com`. CRD: `users.cluster.redpanda.com`. Example API version: `cluster.redpanda.com/v1alpha2`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

## Provisioning

Create the broker using `crds/redpanda.cluster.redpanda.com` and topics using `crds/topic.cluster.redpanda.com`. Give each application component its own principal and minimum topic/group permissions. The example is a consumer; producers need Write permission on their output topics, and a component that consumes and produces needs both sets of permissions.

```yaml
apiVersion: secretgenerator.mittwald.de/v1alpha1
kind: StringSecret
metadata:
  name: example-worker-kafka
spec:
  forceRegenerate: false
  fields:
    - fieldName: password
      encoding: hex
      length: '32'
---
apiVersion: cluster.redpanda.com/v1alpha2
kind: User
metadata:
  name: example-worker
spec:
  cluster:
    clusterRef:
      name: example-redpanda
  authentication:
    type: scram-sha-512
    password:
      valueFrom:
        secretKeyRef:
          name: example-worker-kafka
          key: password
  authorization:
    acls:
      - type: allow
        resource:
          type: topic
          name: example-images
          patternType: literal
        operations:
          - Read
          - Describe
      - type: allow
        resource:
          type: group
          name: example-worker
          patternType: literal
        operations:
          - Read
          - Describe
```

Consume the same generated Secret in the application; do not commit the generated password or grant all topics/groups as a shortcut. Use `example-worker` as the SASL username, SCRAM-SHA-512 as the mechanism, and verified broker TLS as described in `crds/redpanda.cluster.redpanda.com`. Check reconciliation status and authentication/authorization with the intended principal. Password rotation must reconcile both the broker identity and application clients; environment-backed credentials require client restart after the Secret changes.
