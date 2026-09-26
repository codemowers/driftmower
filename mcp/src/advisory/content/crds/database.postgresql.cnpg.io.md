# PostgreSQL databases — Database.postgresql.cnpg.io

Qualified kind: `Database.postgresql.cnpg.io`. CRD: `databases.postgresql.cnpg.io`. Example API version: `postgresql.cnpg.io/v1`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

## Provisioning

Create the backing Cluster using `crds/cluster.postgresql.cnpg.io`. Its bootstrap creates the application role and initial database. A Database resource manages the named database and its supported extensions; it does not provision a PostgreSQL server or supply missing extension binaries.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Database
metadata:
  name: example-database-app
spec:
  name: example
  owner: example
  cluster:
    name: example-database
  extensions:
    - name: vector
    - name: postgis
```

The example assumes that the Cluster has compatible pgvector and PostGIS libraries available. Omit extensions the application does not use. For CNPG image-volume extensions, configure `spec.postgresql.extensions` on the Cluster as well as `spec.extensions` on this resource. SQL extension names and image extension names can differ (`vector` versus `pgvector`). PostGIS image extensions that depend on system GEOS libraries need an `ld_library_path` list containing `system` in the Cluster's extension declaration. Select compatible extension images from the target platform rather than inventing a tag.

Read the Database status before treating extension setup as successful; an accepted Kubernetes object is not proof of successful SQL reconciliation. Applications still own their fresh-install table/schema creation. Consume the Cluster's application connection Secret and CA as described in `crds/cluster.postgresql.cnpg.io`; do not embed database passwords in this resource or application code.

Choose deletion and retention behavior deliberately. Do not blindly copy a Helm keep annotation: keeping a resource is not a backup, and retained resources remain outside later release cleanup.
