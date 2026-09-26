# PostgreSQL — Cluster.postgresql.cnpg.io

Qualified kind: `Cluster.postgresql.cnpg.io`. CRD: `clusters.postgresql.cnpg.io`. Example API version: `postgresql.cnpg.io/v1`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

CNPG supplies the PostgreSQL listener configuration; do not try to override its fixed `listen_addresses` parameter. Verify IPv6 connectivity on the target cluster rather than inferring it from a Service alone. Use the operator-generated application credentials. Follow the target admission policies for certificate provisioning and the server CA; do not assume it is the CNPG-generated CA.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: example-database
spec:
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
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: '1'
      memory: 1Gi
```

## Operator-provisioned application Secret

With the default generated credentials for `bootstrap.initdb`, CNPG creates `<Cluster-name>-app` in the Cluster's namespace (for example, `example-database-app`). Consume its keys through `secretKeyRef` or a Secret volume instead of constructing connection strings or generating a second password. The keys below describe decoded values; Kubernetes represents them as base64 under Secret `data`.

| Key | Decoded value and use |
| --- | --- |
| `dbname` | Application database name from `bootstrap.initdb.database`. |
| `user` | Application database role from `bootstrap.initdb.owner`. |
| `username` | The same application role as `user`; useful for clients expecting this key name. |
| `password` | Generated application-role password. |
| `host` | Short read/write Service name, `<Cluster-name>-rw`; resolves within the same namespace. |
| `port` | PostgreSQL port as a string, normally `5432`. |
| `uri` | PostgreSQL connection URI containing credentials, database and the namespace-qualified read/write Service host (`<Cluster-name>-rw.<namespace>`). |
| `fqdn-uri` | PostgreSQL connection URI using the fully qualified Service host (`<Cluster-name>-rw.<namespace>.svc.<cluster-domain>`). |
| `jdbc-uri` | JDBC PostgreSQL URL using the namespace-qualified Service host, with `user` and `password` query parameters. |
| `fqdn-jdbc-uri` | JDBC PostgreSQL URL using the fully qualified Service host, with `user` and `password` query parameters. |
| `pgpass` | PostgreSQL password-file entry: `host:port:dbname:user:password`, using the short Service host. Mount with permissions accepted by libpq and ensure the connection host matches the entry. |

Use `fqdn-uri` or `fqdn-jdbc-uri` when a fully qualified address is required; the cluster domain is commonly `cluster.local`. URI, JDBC and `pgpass` values contain credentials: reference them directly rather than logging or copying them into manifests. These connection strings do not by themselves enable verified TLS; configure the client's TLS mode and trust roots. Custom bootstrap credentials can change which Secret is used; check the configured Secret and its keys.

Application environment fragment (for PostgreSQL clients that honor libpq-compatible environment settings). Mount the CA selected by the target certificate configuration at the path used by `PGSSLROOTCERT`:

```yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: example-database-app
        key: uri
  - name: PGSSLMODE
    value: verify-full
  - name: PGSSLROOTCERT
    value: /etc/postgres-ca/ca.crt
```

Check the specific client library: a connection URL can override environment settings, and some clients ignore `PGSSLMODE`. Require certificate and hostname verification in the actual client.


## Databases and extensions

Use `crds/database.postgresql.cnpg.io` to declare database ownership and SQL extensions. The Cluster owns the PostgreSQL runtime, storage, roles/bootstrap and available extension libraries; the Database resource enables supported extensions in a specific database. Match runtime and extension images to the same PostgreSQL major version and base distribution. Do not copy extension-image versions between clusters without checking compatibility.
