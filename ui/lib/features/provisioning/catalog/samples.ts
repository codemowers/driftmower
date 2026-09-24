// PURE. The other half of the catalog offerings.ts describes: the smallest
// manifest that actually gets you an instance of each offering, in the same
// spirit as the Ingress snippet on the hostname card — something to paste and
// then edit, not a wizard.
//
// Rules these samples follow:
//   - apiVersion comes from what the cluster negotiated, never from the recipe,
//     so a sample is never for a version this cluster does not serve.
//   - one replica and a small disk: a sample is for trying the thing out.
//   - the namespace line is omitted when no sandbox is selected, so the paste
//     lands in whatever namespace the user's context points at.
//   - the storage class line is omitted when the cluster has no preferred one,
//     which leaves the cluster default in charge rather than naming a class
//     that may not exist.
//   - image/engine versions are pinned because an unpinned sample that fails to
//     apply is worse than one that occasionally needs bumping; the operator's
//     docs link on the card is the place to check them.

import { OFFERINGS_BY_ID } from "./offerings.ts"
import type { OfferingId, StorageClassFact } from "../types"

export type SampleInput = {
  // "postgresql.cnpg.io/v1" — the version this cluster serves.
  apiVersion: string
  namespace: string | null
  // The namespace's codemowers.io/sandbox label, when it is a sandbox. Some
  // offerings name things outside the namespace and must prefix them with it.
  sandboxId?: string | null
  storageClass: string | null
}

export type OfferingSample = {
  yaml: string
  // What the operator makes out of it, named so the user can go and look.
  creates: string
  // A command that reads the credential the operator generated, or null when
  // the offering generates none. Never a value: this app does not read Secrets.
  connect: string | null
}

// The class the offering would rather have, if this cluster has it. Falls back
// to the cluster default by returning null, which drops the field entirely.
export function pickStorageClass(id: OfferingId, classes: StorageClassFact[]): string | null {
  const preferred = OFFERINGS_BY_ID.get(id)?.storageClassPreference ?? []
  for (const name of preferred) {
    if (classes.some(c => c.name === name)) return name
  }
  return null
}

function head(apiVersion: string, kind: string, name: string, namespace: string | null): string {
  return `apiVersion: ${apiVersion}
kind: ${kind}
metadata:
  name: ${name}${namespace ? `\n  namespace: ${namespace}` : ""}`
}

// `kubectl -n foo ` or plain `kubectl `, matching whether the sample pins a namespace.
function kubectl(namespace: string | null): string {
  return namespace ? `kubectl -n ${namespace}` : "kubectl"
}

function line(indent: number, key: string, value: string | null): string {
  return value === null ? "" : `\n${" ".repeat(indent)}${key}: ${value}`
}

const SAMPLES: Record<OfferingId, (input: SampleInput) => OfferingSample> = {
  postgres: ({ apiVersion, namespace, storageClass }) => ({
    yaml: `${head(apiVersion, "Cluster", "my-postgres", namespace)}
spec:
  instances: 1
  storage:
    size: 2Gi${line(4, "storageClass", storageClass)}`,
    creates:
      "A Postgres instance plus the my-postgres-rw (read-write) and my-postgres-ro Services, and a my-postgres-app Secret holding the generated database, user and password.",
    connect: `${kubectl(namespace)} get secret my-postgres-app -o jsonpath='{.data.uri}' | base64 -d`,
  }),

  dragonfly: ({ apiVersion, namespace }) => ({
    yaml: `${head(apiVersion, "Dragonfly", "my-cache", namespace)}
spec:
  replicas: 1`,
    creates:
      "A Redis-protocol cache reachable at my-cache:6379 in this namespace. Nothing is persisted unless you add a snapshot volume.",
    // No auth unless spec.authentication is set, so there is no secret to read.
    connect: null,
  }),

  mongodb: ({ apiVersion, namespace, storageClass }) => ({
    // MongoDBCommunity has no meaningful default: the user list, its password
    // Secret and the SCRAM credentials secret name are all required, so a
    // shorter sample would simply not apply.
    yaml: `${head(apiVersion, "MongoDBCommunity", "my-mongodb", namespace)}
spec:
  members: 1
  type: ReplicaSet
  version: "8.0.4"
  security:
    authentication:
      modes: ["SCRAM"]
  users:
    - name: app
      db: admin
      passwordSecretRef:
        name: my-mongodb-password
      roles:
        - name: readWrite
          db: app
      scramCredentialsSecretName: my-mongodb-scram
  statefulSet:
    spec:
      volumeClaimTemplates:
        - metadata:
            name: data-volume
          spec:
            accessModes: ["ReadWriteOnce"]
            resources:
              requests:
                storage: 2Gi${line(12, "storageClassName", storageClass)}
---
apiVersion: v1
kind: Secret
metadata:
  name: my-mongodb-password${namespace ? `\n  namespace: ${namespace}` : ""}
stringData:
  # Replace this before applying: the operator hashes whatever it finds here.
  password: change-me`,
    creates:
      "A single-member replica set, and a my-mongodb-admin-app Secret holding the connection string for the user above. Needs the mongodb-database ServiceAccount, Role and RoleBinding in this namespace first — without them the pods never start.",
    connect: `${kubectl(namespace)} get secret my-mongodb-admin-app -o jsonpath='{.data.connectionString\\.standard}' | base64 -d`,
  }),

  bucket: ({ apiVersion, namespace, sandboxId }) => {
    // spec.quota.default is required by the CRD, so a sample without it is
    // rejected on apply rather than defaulted.
    if (!sandboxId) {
      return {
        yaml: `${head(apiVersion, "Bucket", "my-bucket", namespace)}
spec:
  name: my-bucket
  s3InstanceRef: minio/default
  quota:
    default: 1Gi`,
        creates:
          "A bucket on the cluster's MinIO. Access keys are not generated by this object; add an S3User with a Policy for a scoped user.",
        connect: null,
      }
    }

    // In a sandbox, sandbox-s3-guard holds bucket names and access keys to the
    // sandbox-id prefix (both are global on the MinIO, not per namespace) and
    // lets an S3User attach only the platform-rendered <id>-rw policy, which
    // covers exactly the <id>-* buckets. The S3User makes the sample usable:
    // without it the bucket exists and nothing can reach it.
    return {
      yaml: `${head(apiVersion, "Bucket", "my-bucket", namespace)}
spec:
  # Global on the MinIO: must start with ${sandboxId}-
  name: ${sandboxId}-my-bucket
  s3InstanceRef: minio/default
  quota:
    default: 1Gi
---
${head(apiVersion, "S3User", "my-bucket-user", namespace)}
spec:
  accessKey: ${sandboxId}-my-bucket-user
  # Required: the CRD's default instance does not exist on these clusters.
  s3InstanceRef: minio/default
  policies:
    - ${sandboxId}-rw
  secretName: my-bucket-credentials`,
      creates: `A 1Gi bucket named ${sandboxId}-my-bucket on the cluster's MinIO, and an S3User whose access key and secret land in the my-bucket-credentials Secret (accessKey, secretKey). Its ${sandboxId}-rw policy reaches this sandbox's buckets and no one else's.`,
      connect: `${kubectl(namespace)} get secret my-bucket-credentials -o jsonpath='{.data.secretKey}' | base64 -d`,
    }
  },

  rabbitmq: ({ apiVersion, namespace, storageClass }) => ({
    yaml: `${head(apiVersion, "RabbitmqCluster", "my-rabbit", namespace)}
spec:
  replicas: 1
  persistence:
    storage: 2Gi${line(4, "storageClassName", storageClass)}`,
    creates:
      "A broker reachable at my-rabbit:5672 (AMQP) and :15672 (management UI), and a my-rabbit-default-user Secret with the generated credentials.",
    connect: `${kubectl(namespace)} get secret my-rabbit-default-user -o jsonpath='{.data.password}' | base64 -d`,
  }),

  redpanda: ({ apiVersion, namespace, storageClass }) => ({
    // The Redpanda CR is a thin wrapper over the Helm chart's values, so
    // everything below clusterSpec is chart configuration rather than a
    // hand-written API.
    yaml: `${head(apiVersion, "Redpanda", "my-redpanda", namespace)}
spec:
  clusterSpec:
    statefulset:
      replicas: 1
    storage:
      persistentVolume:
        enabled: true
        size: 10Gi${line(8, "storageClass", storageClass)}`,
    creates:
      "A single-broker Kafka-protocol cluster. Run kubectl get svc to see the listener ports the chart settled on before wiring a client to it.",
    connect: null,
  }),

  opensearch: ({ apiVersion, namespace, storageClass }) => ({
    yaml: `${head(apiVersion, "OpenSearchCluster", "my-opensearch", namespace)}
spec:
  general:
    version: "2.17.1"
    serviceName: my-opensearch
  dashboards:
    enable: false
  nodePools:
    - component: nodes
      replicas: 1
      roles: ["cluster_manager", "data"]
      diskSize: "10Gi"
      persistence:
        pvc:
          accessModes: ["ReadWriteOnce"]${line(10, "storageClass", storageClass)}`,
    creates:
      "A single-node cluster at my-opensearch:9200. Without a spec.security block it comes up on OpenSearch's demo security configuration, which is not something to leave in place.",
    // The operator generates no credential Secret of its own: the demo config
    // ships fixed users, and real ones come from spec.security.
    connect: null,
  }),

  elasticsearch: ({ apiVersion, namespace, storageClass }) => ({
    yaml: `${head(apiVersion, "Elasticsearch", "my-elasticsearch", namespace)}
spec:
  version: "8.15.3"
  nodeSets:
    - name: default
      count: 1
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes: ["ReadWriteOnce"]
            resources:
              requests:
                storage: 10Gi${line(12, "storageClassName", storageClass)}`,
    creates:
      "A single-node cluster at my-elasticsearch-es-http:9200, with the elastic user's password in a my-elasticsearch-es-elastic-user Secret.",
    connect: `${kubectl(namespace)} get secret my-elasticsearch-es-elastic-user -o jsonpath='{.data.elastic}' | base64 -d`,
  }),

  emqx: ({ apiVersion, namespace }) => ({
    yaml: `${head(apiVersion, "EMQX", "my-emqx", namespace)}
spec:
  image: emqx:5.8`,
    creates:
      "An MQTT broker at my-emqx-listeners:1883, with the dashboard on :18083. The default dashboard login is admin/public — change it.",
    connect: null,
  }),
}

export function sampleFor(id: OfferingId, input: SampleInput): OfferingSample {
  return SAMPLES[id](input)
}
