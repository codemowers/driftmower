# S3 object storage — Policy.s3.onyxia.sh

Qualified kind: `Policy.s3.onyxia.sh`. CRD: `policies.s3.onyxia.sh`. Example API version: `s3.onyxia.sh/v1alpha1`. Scope: namespaced.

These are Helm fragments: replace `example` consistently and use `.Release.Namespace`. Resource sizes are illustrative. These fragments omit platform-assigned fields and assume the relevant admission policies apply. Follow their guidance for prerequisite resources and use `describe_cluster_capabilities`, `list_offerings`, `describe_namespace_readiness`, `list_storage_classes` and `list_admission_policies` as available to inspect the target cluster. CRD presence alone does not prove operator health or permission. Check the served API version and live CRD schema when the installed version differs; the examples and client wiring below are included so routine provisioning does not require an online documentation lookup. Read `deploying/general`, `deploying/storage`, `deploying/networking` and `deploying/security` for shared requirements.

Declare access to the application's bucket, not all buckets on the MinIO instance. The Policy's `spec.name` is the name referenced by S3User; it is distinct from Kubernetes `metadata.name`. Use the same instance reference and bucket name as `crds/bucket.s3.onyxia.sh`.

```yaml
apiVersion: s3.onyxia.sh/v1alpha1
kind: Policy
metadata:
  name: example-images
spec:
  name: {{ .Release.Namespace }}-images
  policyContent: |
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": [
            "s3:ListBucket",
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject"
          ],
          "Resource": [
            "arn:aws:s3:::{{ .Release.Namespace }}-images",
            "arn:aws:s3:::{{ .Release.Namespace }}-images/*"
          ]
        }
      ]
    }
```

Bucket-level actions such as ListBucket apply to the bucket ARN; object-level actions apply to the `/*` ARN. The example lists both. Remove PutObject/DeleteObject for read-only consumers and omit ListBucket if it is unnecessary. Attach this named policy through `crds/s3user.s3.onyxia.sh`; a Policy object alone does not grant an application access. Verify permissions with that application's principal, including rejection of access outside its bucket.
