import assert from "node:assert/strict"
import { test } from "node:test"

import { OFFERINGS } from "./offerings.ts"
import { pickStorageClass, sampleFor } from "./samples.ts"
import type { StorageClassFact } from "../types.ts"

const CLASSES = [
  { name: "postgres" },
  { name: "local-path", isDefault: true },
] as unknown as StorageClassFact[]

test("every offering in the catalog has a sample", () => {
  for (const offering of OFFERINGS) {
    const sample = sampleFor(offering.id, {
      apiVersion: `${offering.group}/${offering.versions[0]}`,
      namespace: "sb-demo",
      storageClass: null,
    })
    assert.match(sample.yaml, /^apiVersion: /, `${offering.id} must start with apiVersion`)
    assert.match(sample.yaml, new RegExp(`^kind: ${offering.kind}$`, "m"), `${offering.id} kind`)
    assert.ok(sample.creates.length > 0, `${offering.id} must say what it creates`)
  }
})

// The version the cluster negotiated wins, always: a sample for a version this
// cluster does not serve is worse than no sample.
test("the sample carries the negotiated apiVersion, not the recipe's preference", () => {
  const sample = sampleFor("redpanda", {
    apiVersion: "cluster.redpanda.com/v1alpha1",
    namespace: null,
    storageClass: null,
  })
  assert.match(sample.yaml, /^apiVersion: cluster\.redpanda\.com\/v1alpha1$/m)
})

test("no sandbox selected means no namespace line, so the paste follows the kubectl context", () => {
  const scoped = sampleFor("postgres", {
    apiVersion: "postgresql.cnpg.io/v1",
    namespace: "sb-demo",
    storageClass: null,
  })
  assert.match(scoped.yaml, /^ {2}namespace: sb-demo$/m)
  assert.match(scoped.connect ?? "", /kubectl -n sb-demo/)

  const unscoped = sampleFor("postgres", {
    apiVersion: "postgresql.cnpg.io/v1",
    namespace: null,
    storageClass: null,
  })
  assert.doesNotMatch(unscoped.yaml, /namespace:/)
  assert.match(unscoped.connect ?? "", /^kubectl get secret/)
})

// Naming a class the cluster does not have would make the sample fail to bind;
// dropping the field leaves the cluster default in charge.
test("the storage class line is dropped rather than guessed", () => {
  const withClass = sampleFor("postgres", {
    apiVersion: "postgresql.cnpg.io/v1",
    namespace: null,
    storageClass: "postgres",
  })
  assert.match(withClass.yaml, /^ {4}storageClass: postgres$/m)

  const without = sampleFor("postgres", {
    apiVersion: "postgresql.cnpg.io/v1",
    namespace: null,
    storageClass: null,
  })
  assert.doesNotMatch(without.yaml, /storageClass/)
})

test("storage class preference falls back to the cluster default by asking for nothing", () => {
  assert.equal(pickStorageClass("postgres", CLASSES), "postgres")
  // Nothing the offering prefers is here, and mongo's preferred class is absent.
  assert.equal(pickStorageClass("mongodb", CLASSES), null)
  // An offering with no preference never names a class.
  assert.equal(pickStorageClass("rabbitmq", CLASSES), null)
})

// Both were caught by `kubectl apply --dry-run=server` against a cluster that
// runs these operators, and both are the kind of omission that only shows up on
// apply: the CRD requires the field, so a sample without it is simply rejected.
test("samples keep the fields their CRDs require", () => {
  const bucket = sampleFor("bucket", {
    apiVersion: "s3.onyxia.sh/v1alpha1",
    namespace: null,
    storageClass: null,
  })
  assert.match(bucket.yaml, /^ {2}quota:\n {4}default: /m)

  // MongoDBCommunity cannot come up without a password Secret to hash, so the
  // sample has to be two documents.
  const mongo = sampleFor("mongodb", {
    apiVersion: "mongodbcommunity.mongodb.com/v1",
    namespace: null,
    storageClass: null,
  })
  assert.match(mongo.yaml, /^---$/m)
  assert.match(mongo.yaml, /^kind: Secret$/m)
})

// Bucket and S3User names are global on the MinIO, so platform-manager's
// sandbox-s3-guard holds them to the sandbox-id prefix and pins S3Users to the
// platform-rendered <id>-rw policy. A sample that ignores that is rejected.
test("in a sandbox the bucket sample carries the prefix the guard enforces", () => {
  const sample = sampleFor("bucket", {
    apiVersion: "s3.onyxia.sh/v1alpha1",
    namespace: "sb-abc123-demo",
    sandboxId: "abc123-demo",
    storageClass: null,
  })
  assert.match(sample.yaml, /^ {2}name: abc123-demo-my-bucket$/m)
  assert.match(sample.yaml, /^kind: S3User$/m)
  assert.match(sample.yaml, /^ {2}accessKey: abc123-demo-my-bucket-user$/m)
  assert.match(sample.yaml, /^ {4}- abc123-demo-rw$/m)
  // The CRD defaults it to an instance these clusters do not have.
  assert.equal(sample.yaml.match(/^ {2}s3InstanceRef: minio\/default$/gm)?.length, 2)
  assert.match(sample.connect ?? "", /^kubectl -n sb-abc123-demo get secret my-bucket-credentials /)
})

test("outside a sandbox the bucket sample stays a single unprefixed Bucket", () => {
  const sample = sampleFor("bucket", { apiVersion: "s3.onyxia.sh/v1alpha1", namespace: null, storageClass: null })
  assert.match(sample.yaml, /^ {2}name: my-bucket$/m)
  assert.doesNotMatch(sample.yaml, /S3User/)
})
