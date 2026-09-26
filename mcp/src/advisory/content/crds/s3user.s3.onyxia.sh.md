# S3 object storage — S3User.s3.onyxia.sh

Qualified kind: `S3User.s3.onyxia.sh`. CRD: `s3users.s3.onyxia.sh`. Example API version: `s3.onyxia.sh/v1alpha1`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

Bind an application identity to the policy from `crds/policy.s3.onyxia.sh` on the same MinIO instance as `crds/bucket.s3.onyxia.sh`. The operator owns the resulting access credentials; consume them through Secret references.

```yaml
apiVersion: s3.onyxia.sh/v1alpha1
kind: S3User
metadata:
  name: example-images
spec:
  accessKey: {{ .Release.Namespace }}-images
  policies:
    - {{ .Release.Namespace }}-images
```

For this operator's illustrated pattern, the generated Secret is named after the S3User resource (`example-images`) and contains `accessKey` and `secretKey`. Verify the generated Secret metadata and keys against the installed operator before wiring a different version; do not print the credentials while inspecting them.

```yaml
env:
  - name: S3_ACCESS_KEY
    valueFrom:
      secretKeyRef:
        name: example-images
        key: accessKey
  - name: S3_SECRET_KEY
    valueFrom:
      secretKeyRef:
        name: example-images
        key: secretKey
  - name: S3_BUCKET
    value: {{ .Release.Namespace }}-images
```

Supply deployment-specific internal/public HTTPS endpoints separately, mount the platform CA and configure the SDK's verification. `S3_ACCESS_KEY`/`S3_SECRET_KEY` are application conventions; map them explicitly into the chosen SDK. Rotate credentials through their owning operator and restart clients that read credentials only from environment variables. Never copy generated credentials into Helm values, source code or images.
