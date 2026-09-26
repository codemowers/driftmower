# Redis-compatible cache — Dragonfly.dragonflydb.io

Qualified kind: `Dragonfly.dragonflydb.io`. CRD: `dragonflies.dragonflydb.io`. Example API version: `dragonflydb.io/v1alpha1`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

```yaml
apiVersion: secretgenerator.mittwald.de/v1alpha1
kind: StringSecret
metadata:
  name: example-redis-password
spec:
  forceRegenerate: false
  fields:
    - fieldName: password
      encoding: hex
      length: '32'
---
apiVersion: dragonflydb.io/v1alpha1
kind: Dragonfly
metadata:
  name: example-redis
spec:
  authentication:
    passwordFromSecret:
      name: example-redis-password
      key: password
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

Use the Service DNS name covered by the certificate, the generated password Secret, and the platform CA bundle. For Node/ioredis, configure `REDIS_URL=rediss://example-redis.<namespace>.svc.cluster.local:6379/0`, pass `REDIS_PASSWORD` explicitly as the client's password option, and set `NODE_EXTRA_CA_CERTS` to a mounted `cluster-ca-certs` ConfigMap's `ca.crt`. For Go clients, configure TLS roots and hostname verification; `REDIS_TLS` and `SSL_CERT_FILE` are application conventions, not automatic Redis protocol settings. Never use `rejectUnauthorized: false` or `InsecureSkipVerify`.

**Certificate provisioning does not ensure runtime reload.** cert-manager renews the Secret and Kubernetes updates its mounted files, but Dragonfly v1.37.0 reloads them only on `CONFIG SET tls true` (or process restart). Provide a platform renewal controller or scheduled maintenance Job that reloads every instance after Secret projection, with authentication, verified TLS, bounded timeouts and visible failures. A load-balanced Service reaches only one instance; it is insufficient for replica-wide reload. Verify the served certificate fingerprint after rotation and before expiry. Do not restart an ephemeral single instance as an unnoticed renewal strategy: that can discard its data.

This behavior was checked against [Dragonfly v1.37.0 TLS configuration](https://github.com/dragonflydb/dragonfly/blob/v1.37.0/src/server/server_family.cc#L1132) and [operator revision 9441192](https://github.com/dragonflydb/dragonfly-operator/blob/9441192c0782690bfbddffacd52fc2dc49c5f3b6/internal/controller/dragonfly_controller.go). That operator does not watch TLS Secrets or issue TLS reload commands. Check the installed version before assuming later releases behave identically.

The same operator deliberately disables TLS on its administrative port and uses that port for management and replication. `tlsSecretRef` therefore encrypts application connections, not every operator channel. Keep the admin port private under operator-managed NetworkPolicy; do not override its TLS flags without verifying operator compatibility. A requirement to encrypt administrative/replication traffic needs operator support, not just this application manifest. See the [operator's TLS resource construction](https://github.com/dragonflydb/dragonfly-operator/blob/9441192c0782690bfbddffacd52fc2dc49c5f3b6/internal/resources/resources.go#L428).
