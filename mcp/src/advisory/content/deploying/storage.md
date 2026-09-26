# State and persistence

- Keep application containers stateless where possible and store state in external databases or caches.
- Use a read-only root filesystem to enforce that boundary.

- Use `list_offerings`, when advertised, to discover available operator-backed databases, queues, caches, and object storage. Configure the application with the provisioned endpoint and credential references.

- Give applications that need temporary files a bounded `emptyDir` volume mounted at `/tmp` or another explicit scratch path while keeping the root filesystem read-only. Point library caches and temporary-file settings there. Treat this data as disposable when the Pod is replaced.
- Provision PostgreSQL with `Cluster.postgresql.cnpg.io`; manage databases and supported extensions with `Database.postgresql.cnpg.io`. Consume operator-generated connection Secrets instead of assembling or committing credentials.
- Consume MinIO through `Bucket.s3.onyxia.sh`, with `Policy.s3.onyxia.sh` and `S3User.s3.onyxia.sh` for scoped access. Do not deploy MinIO instances manually. Restrict access to the required buckets and operations, and consume the generated credentials through Secret references.
- Configure internal object-storage endpoints separately from browser-facing endpoints. Generate presigned URLs for the endpoint the browser will actually use; do not assume a signed URL remains valid after changing its host.
- Keep MinIO/S3 transfers direct between the client and the storage endpoint; do not proxy signed requests or object bytes through a BFF or application API. Authorize the operation before issuing a scoped presigned URL, and configure storage CORS for the browser origins that need access. See `developing/architecture` for signed-request service boundaries.
- Define retention and deletion behavior deliberately for persistent operator resources. A Helm keep annotation preserves a resource during relevant Helm deletion operations; it is not a backup. Keep backup and restore procedures explicit.

TODO: PVC lifecycle, storage-class selection, backup, and restore procedures. For this cluster's provisioning instructions and storage settings, consult `list_storage_classes`; consult `list_admission_policies` for admission defaults.

## PostgreSQL and Dragonfly examples

These Helm fragments adapt the `lolcatz` application pattern. Replace `example` consistently, use `.Release.Namespace`, and inspect the target cluster's CRDs, admission defaults, issuers and trust bundles first. Do not copy a cluster's replica counts or storage classes into another cluster. TLS server configuration, client verification, authentication and certificate reload are separate requirements.

### CloudNativePG: operator-managed TLS

CNPG supplies the PostgreSQL listener configuration and TLS certificates; do not try to override its fixed `listen_addresses` parameter. Verify IPv6 connectivity on the target cluster rather than inferring it from a Service alone. Use the operator-generated application credentials and its PostgreSQL CA, which is distinct from the platform CA used by Dragonfly below.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: example-database
spec:
  instances: 1 # The target platform may assign replicas automatically.
  bootstrap:
    initdb:
      database: example
      owner: example
  postgresql:
    pg_hba:
      - hostnossl all all 0.0.0.0/0 reject
      - hostnossl all all ::/0 reject
  storage:
    size: 10Gi
  resources:
    requests: {cpu: 100m, memory: 256Mi}
    limits: {cpu: "1", memory: 1Gi}
```

Application Pod fragment (for PostgreSQL clients that honor libpq-compatible environment settings):

```yaml
volumes:
  - name: postgres-ca
    secret:
      secretName: example-database-ca
      items: [{key: ca.crt, path: ca.crt}]
containers:
  - name: app
    # image, ports and other application settings omitted
    volumeMounts:
      - {name: postgres-ca, mountPath: /etc/postgres-ca, readOnly: true}
    env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef: {name: example-database-app, key: uri}
      - {name: PGSSLMODE, value: verify-full}
      - {name: PGSSLROOTCERT, value: /etc/postgres-ca/ca.crt}
```

Check the specific client library: a connection URL can override environment settings, and some clients ignore `PGSSLMODE`. Require certificate and hostname verification in the actual client. CNPG renews and reloads its operator-managed certificates. For cert-manager-managed certificates, configure `serverTLSSecret` and `serverCASecret`, and label the generated Secret `cnpg.io/reload: "true"` through the Certificate's `secretTemplate`. See [CNPG certificates](https://cloudnative-pg.io/docs/1.25/certificates/).

### Dragonfly: IPv6, generated password and server TLS

```yaml
apiVersion: secretgenerator.mittwald.de/v1alpha1
kind: StringSecret
metadata:
  name: example-redis-password
spec:
  forceRegenerate: false
  fields:
    - {fieldName: password, encoding: hex, length: "32"}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: example-redis-internal-tls
spec:
  secretName: example-redis-internal-tls
  dnsNames:
    - example-redis.{{ .Release.Namespace }}
    - example-redis.{{ .Release.Namespace }}.svc.cluster.local
  issuerRef:
    name: cluster-tls-issuer
    kind: ClusterIssuer
    group: cert-manager.io
---
apiVersion: dragonflydb.io/v1alpha1
kind: Dragonfly
metadata:
  name: example-redis
spec:
  replicas: 1
  authentication:
    passwordFromSecret: {name: example-redis-password, key: password}
  tlsSecretRef:
    name: example-redis-internal-tls
  args:
    - --bind=::
    - --admin_bind=::
  resources:
    requests: {cpu: 50m, memory: 128Mi}
    limits: {cpu: 500m, memory: 512Mi}
```

Use the Service DNS name covered by the certificate, the generated password Secret, and the platform CA bundle. For Node/ioredis, configure `REDIS_URL=rediss://example-redis.<namespace>.svc.cluster.local:6379/0`, pass `REDIS_PASSWORD` explicitly as the client's password option, and set `NODE_EXTRA_CA_CERTS` to a mounted `cluster-ca-certs` ConfigMap's `ca.crt`. For Go clients, configure TLS roots and hostname verification; `REDIS_TLS` and `SSL_CERT_FILE` are application conventions, not automatic Redis protocol settings. Never use `rejectUnauthorized: false` or `InsecureSkipVerify`.

**Operator shortcoming: certificate renewal is not propagated to Dragonfly.** cert-manager renews the Secret and Kubernetes updates its mounted files, but Dragonfly v1.37.0 reloads them only on `CONFIG SET tls true` (or process restart). The operator must handle renewal for every instance; do not add application CronJobs, sidecars or reload loops to compensate. Report this limitation when evaluating TLS readiness. A changed Secret is not evidence that the server is serving the new certificate. Restarting an ephemeral single instance can discard its data.

This behavior was checked against [Dragonfly v1.37.0 TLS configuration](https://github.com/dragonflydb/dragonfly/blob/v1.37.0/src/server/server_family.cc#L1132) and [operator revision 9441192](https://github.com/dragonflydb/dragonfly-operator/blob/9441192c0782690bfbddffacd52fc2dc49c5f3b6/internal/controller/dragonfly_controller.go). That operator does not watch TLS Secrets or issue TLS reload commands. Check the installed version before assuming later releases behave identically.

The same operator deliberately disables TLS on its administrative port and uses that port for management and replication. `tlsSecretRef` therefore encrypts application connections, not every operator channel. Keep the admin port private under operator-managed NetworkPolicy; do not override its TLS flags without verifying operator compatibility. A requirement to encrypt administrative/replication traffic needs operator support, not just this application manifest. See the [operator's TLS resource construction](https://github.com/dragonflydb/dragonfly-operator/blob/9441192c0782690bfbddffacd52fc2dc49c5f3b6/internal/resources/resources.go#L428).
