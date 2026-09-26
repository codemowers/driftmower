# S3 object storage — Bucket.s3.onyxia.sh

Qualified kind: `Bucket.s3.onyxia.sh`. CRD: `buckets.s3.onyxia.sh`. Example API version: `s3.onyxia.sh/v1alpha1`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

Provision a bucket on the platform's existing MinIO instance. Do not deploy an application-owned MinIO server. The namespace-qualified bucket name avoids collisions in shared object storage. Set quota and retention deliberately.

```yaml
apiVersion: s3.onyxia.sh/v1alpha1
kind: Bucket
metadata:
  name: example-images
spec:
  name: {{ .Release.Namespace }}-images
  quota:
    default: 100000000000
```

Create scoped access with `crds/policy.s3.onyxia.sh` and `crds/s3user.s3.onyxia.sh`. Discover the S3 endpoint separately; the Bucket resource does not make an endpoint available at its Kubernetes name. Require HTTPS and verified platform trust in Kubernetes.

Keep the internal endpoint separate from the browser-facing endpoint. Sign presigned URLs using the endpoint the browser actually uses: changing the host after signing invalidates the signature. Public downloads do not require an anonymously writable bucket. Prefer scoped access and presigned URLs over broad anonymous policy.

Inspect reconciliation status and actual quota/deletion behavior before treating the bucket as ready. A keep annotation is not a backup; document object lifecycle and backup/restore separately.
