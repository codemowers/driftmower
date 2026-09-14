// PURE. The descriptive half of the catalog: what each offering IS, which kind
// its operator serves, and where that operator lives. The manifest-rendering
// half (presets, companions, notes) lands alongside this per offering.
//
// Titles are the product a user has heard of ("PostgreSQL"), never the operator
// ("cnpg"). The operator is an implementation detail shown on a `via` line.

import type { OfferingId, PresetId, Purpose } from "../types"

export type OfferingSpec = {
  id: OfferingId
  name: string
  purpose: Purpose
  what: string
  goodFor: string[]
  // Discovery key. The recipe's supported versions, preferred first — the
  // planner intersects these with what the cluster actually serves.
  group: string
  kind: string
  versions: string[]
  operator: { name: string; vendor: string; docsHref: string }
  // Where the controller runs, for the health check. `deployment` is matched as
  // a prefix because Helm prepends the release name.
  operatorRef: { namespace: string; deployment: string }
  storageClassPreference: string[]
  presets: { id: PresetId; label: string; summary: string }[]
  // Rendered on a not-installed card so it is never a dead end.
  needs: string[]
  stateful: boolean
}

const STANDARD_PRESETS = (dev: string, small: string, ha: string) => [
  { id: "dev" as PresetId, label: "Dev", summary: dev },
  { id: "small" as PresetId, label: "Small", summary: small },
  { id: "ha" as PresetId, label: "Highly available", summary: ha },
]

export const OFFERINGS: OfferingSpec[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    purpose: "relational",
    what: "A relational database with tables, SQL and transactions.",
    goodFor: ["application data", "orders and users", "anything you would reach for SQL to query"],
    group: "postgresql.cnpg.io",
    kind: "Cluster",
    versions: ["v1"],
    operator: {
      name: "CloudNativePG",
      vendor: "cloudnative-pg",
      docsHref: "https://cloudnative-pg.io/documentation/current/",
    },
    operatorRef: { namespace: "cnpg-system", deployment: "cnpg" },
    storageClassPreference: ["postgres"],
    presets: STANDARD_PRESETS("1 instance, 2Gi", "1 instance, 20Gi", "3 instances, 20Gi each, backed up"),
    needs: [
      "The CloudNativePG operator",
      "A storage class for the data volume",
      "Under default-deny networking: apiserver egress, and node-sourced ingress on port 8000 for health probes",
    ],
    stateful: true,
  },
  {
    id: "dragonfly",
    name: "Dragonfly",
    purpose: "cache",
    what: "An in-memory cache that speaks the Redis protocol.",
    goodFor: ["caching", "sessions", "queues and rate limits"],
    group: "dragonflydb.io",
    kind: "Dragonfly",
    versions: ["v1alpha1"],
    operator: {
      name: "Dragonfly operator",
      vendor: "dragonflydb",
      docsHref: "https://www.dragonflydb.io/docs/managing-dragonfly/operator/installation",
    },
    operatorRef: { namespace: "dragonfly-operator-system", deployment: "dragonfly-operator" },
    storageClassPreference: ["redis"],
    presets: STANDARD_PRESETS("1 replica, in memory", "1 replica, 2Gi", "3 replicas"),
    needs: ["The Dragonfly operator", "A generated password secret"],
    stateful: false,
  },
  {
    id: "mongodb",
    name: "MongoDB",
    purpose: "document",
    what: "A document database that stores JSON-like records instead of rows.",
    goodFor: ["documents with varying shapes", "event and audit logs"],
    group: "mongodbcommunity.mongodb.com",
    kind: "MongoDBCommunity",
    versions: ["v1"],
    operator: {
      name: "MongoDB Community operator",
      vendor: "mongodb",
      docsHref: "https://www.mongodb.com/docs/kubernetes-operator/current/",
    },
    operatorRef: { namespace: "mongodb", deployment: "mongodb-kubernetes-operator" },
    storageClassPreference: ["mongo"],
    presets: STANDARD_PRESETS("1 member, 2Gi", "1 member, 20Gi", "3-member replica set"),
    needs: [
      "The MongoDB Community operator",
      "A ServiceAccount, Role and RoleBinding named mongodb-database in the namespace — without them the pods never start",
      "Two volumes per member (data and logs), so it costs two PVCs against the quota",
    ],
    stateful: true,
  },
  {
    id: "bucket",
    name: "S3 bucket",
    purpose: "object-store",
    what: "Object storage for files, addressed over the S3 API.",
    goodFor: ["uploads", "backups", "static assets and exports"],
    group: "s3.onyxia.sh",
    kind: "Bucket",
    versions: ["v1alpha1"],
    operator: {
      name: "s3-operator",
      vendor: "inseefrlab",
      docsHref: "https://github.com/InseeFrLab/s3-operator",
    },
    operatorRef: { namespace: "minio", deployment: "s3-operator" },
    storageClassPreference: [],
    presets: STANDARD_PRESETS("1 bucket", "1 bucket with a scoped user", "1 bucket with a scoped user"),
    needs: ["The s3-operator", "An S3Instance for it to create the bucket in (minio/default on these clusters)"],
    stateful: false,
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    purpose: "queue",
    what: "A message broker that hands work between services.",
    goodFor: ["background jobs", "decoupling services", "retries"],
    group: "rabbitmq.com",
    kind: "RabbitmqCluster",
    versions: ["v1beta1"],
    operator: {
      name: "RabbitMQ Cluster operator",
      vendor: "rabbitmq",
      docsHref: "https://www.rabbitmq.com/kubernetes/operator/operator-overview",
    },
    operatorRef: { namespace: "rabbitmq-system", deployment: "rabbitmq-cluster-operator" },
    storageClassPreference: [],
    presets: STANDARD_PRESETS("1 node, 2Gi", "1 node, 10Gi", "3 nodes, 10Gi each"),
    needs: [
      "The RabbitMQ Cluster operator",
      "For queues and users as manifests, the separate messaging-topology-operator",
    ],
    stateful: true,
  },
  {
    id: "redpanda",
    name: "Redpanda",
    purpose: "stream",
    what: "An event stream that speaks the Kafka protocol.",
    goodFor: ["event streams", "change feeds", "high-volume ingest"],
    group: "cluster.redpanda.com",
    kind: "Redpanda",
    versions: ["v1alpha2", "v1alpha1"],
    operator: {
      name: "Redpanda operator",
      vendor: "redpanda-data",
      docsHref: "https://docs.redpanda.com/current/deploy/deployment-option/self-hosted/kubernetes/k-deployment-overview/",
    },
    operatorRef: { namespace: "redpanda", deployment: "redpanda-controller" },
    storageClassPreference: [],
    presets: STANDARD_PRESETS("1 broker, 10Gi", "1 broker, 20Gi", "3 brokers, 20Gi each"),
    needs: ["The Redpanda operator", "At least 3 zones before the highly-available preset makes sense"],
    stateful: true,
  },
  {
    id: "opensearch",
    name: "OpenSearch",
    purpose: "search",
    what: "A search engine and log store you query with full-text queries.",
    goodFor: ["full-text search", "log analytics", "dashboards"],
    // opensearch.opster.io is still served for existing objects, but the
    // operator's webhook refuses to create new ones under it ("API group is
    // deprecated. Please use opensearch.org/v1 instead"), so discovery has to
    // anchor on the group you can actually apply to.
    group: "opensearch.org",
    kind: "OpenSearchCluster",
    versions: ["v1"],
    operator: {
      name: "OpenSearch operator",
      vendor: "opensearch-project",
      docsHref: "https://opensearch.org/docs/latest/tools/k8s-operator/",
    },
    operatorRef: { namespace: "opensearch-operator-system", deployment: "opensearch-operator" },
    storageClassPreference: [],
    presets: STANDARD_PRESETS("1 node, 10Gi", "1 node, 20Gi", "3 nodes, 20Gi each"),
    needs: [
      "The OpenSearch operator",
      "More memory than the smallest sandbox quota allows — check the namespace before choosing this",
    ],
    stateful: true,
  },
  {
    id: "elasticsearch",
    name: "Elasticsearch",
    purpose: "search",
    what: "A search engine and log store, in the Elastic distribution.",
    goodFor: ["full-text search", "log analytics", "Kibana dashboards"],
    group: "elasticsearch.k8s.elastic.co",
    kind: "Elasticsearch",
    versions: ["v1"],
    operator: {
      name: "Elastic Cloud on Kubernetes",
      vendor: "elastic",
      docsHref: "https://www.elastic.co/guide/en/cloud-on-k8s/current/index.html",
    },
    operatorRef: { namespace: "elastic-system", deployment: "elastic-operator" },
    storageClassPreference: [],
    presets: STANDARD_PRESETS("1 node, 10Gi", "1 node, 20Gi", "3 nodes, 20Gi each"),
    needs: ["The ECK operator", "Awareness of Elastic's licence tiers for anything beyond the basic features"],
    stateful: true,
  },
  {
    id: "emqx",
    name: "EMQX",
    purpose: "mqtt",
    what: "An MQTT broker for device and sensor messages.",
    goodFor: ["IoT devices", "telemetry", "pub/sub over MQTT"],
    group: "apps.emqx.io",
    kind: "EMQX",
    versions: ["v2beta1", "v2alpha1"],
    operator: {
      name: "EMQX operator",
      vendor: "emqx",
      docsHref: "https://docs.emqx.com/en/emqx-operator/latest/",
    },
    operatorRef: { namespace: "emqx-operator-system", deployment: "emqx-operator" },
    storageClassPreference: [],
    presets: STANDARD_PRESETS("1 node", "1 node, 2Gi", "3 core nodes"),
    needs: ["The EMQX operator"],
    stateful: false,
  },
]

export const OFFERINGS_BY_ID = new Map(OFFERINGS.map(o => [o.id, o]))

export function offeringFor(group: string, kind: string): OfferingSpec | null {
  return OFFERINGS.find(o => o.group === group && o.kind === kind) ?? null
}
