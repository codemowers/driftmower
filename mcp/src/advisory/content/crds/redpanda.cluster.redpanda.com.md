# Kafka-compatible broker — Redpanda.cluster.redpanda.com

Qualified kind: `Redpanda.cluster.redpanda.com`. CRD: `redpandas.cluster.redpanda.com`. Example API version: `cluster.redpanda.com/v1alpha2`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

## Provisioning

The Redpanda resource delegates broker lifecycle to the platform operator. Do not add a handwritten broker StatefulSet alongside it. This example uses internal listeners only; choose storage capacity and resource budgets for the workload.

```yaml
apiVersion: cluster.redpanda.com/v1alpha2
kind: Redpanda
metadata:
  name: example-redpanda
spec:
  chartRef: {}
  clusterSpec:
    auth:
      sasl:
        enabled: true
    console:
      enabled: false
    external:
      enabled: false
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: "1"
        memory: 1Gi
    serviceAccount:
      create: true
      name: example-redpanda
    storage:
      persistentVolume:
        size: 10Gi
```

`chartRef: {}` uses the operator's configured chart defaults; inspect the installed operator's resolved chart version and readiness. The operator's chart schema and defaults are version-dependent. Broker TLS does not configure client trust or turn a client into an authenticated principal. Keep the broker's administrative endpoints internal. Check actual listener addresses, ports and TLS modes in the reconciled broker configuration; a Service alone does not guarantee IPv6 or TLS.

## Application wiring

Create topics with `crds/topic.cluster.redpanda.com` and distinct application identities/ACLs with `crds/user.cluster.redpanda.com`. Discover the internal bootstrap endpoint from the reconciled broker Service. In the illustrated platform pattern it is `example-redpanda.<namespace>.svc.cluster.local:9093`; verify the port instead of assuming every chart exposes the same listener.

Use SASL over verified TLS (`SASL_SSL`, SCRAM-SHA-512), the application's generated password Secret, and the namespace platform CA bundle (`trusted-ca-certs` key `ca.pem`, or the target cluster's advertised equivalent). Mount the bundle and configure the actual Kafka library's CA and hostname verification. For confluent-kafka, set `security.protocol`, `sasl.mechanism`, `sasl.username`, `sasl.password` and `ssl.ca.location`. For kafka-go, configure the Dialer's TLS roots and SASL mechanism. Names such as `KAFKA_TLS` are application conventions, not automatic Kafka client settings.

Verify broker and certificate readiness before producing traffic. Inspect how the installed operator handles certificate and credential renewal; projected Secret changes alone do not prove that long-running brokers or clients reload them. Do not disable authentication or certificate verification to bypass a provisioning error.
