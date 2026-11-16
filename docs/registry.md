# Registry scraper and base image matching

[Driftmower](../README.md)

The registry scraper is a separate StatefulSet and Service, using the crawler
image in `registry` mode. It lists public registry tags, applies each repository's
anchored regular expression, resolves Linux amd64 and arm64 manifests (including
variants such as amd64/v3 and arm64/v8), and fetches verified OCI configs. It
does not download image layers. Ordered compressed-layer digests, uncompressed
DiffIDs, tag aliases, labels, manifest annotations, entrypoint/cmd and config
creation timestamps are kept in its retained `catalog-<release>-registry-scraper-0`
PVC. Original config bytes are stored as `config.json.gz`, preserving their
config digest when downloaded and decompressed. The complete build history is
retained in that config, independently of the extracted creation timestamp.

Legacy Docker schema 1 manifests are counted as skipped tags rather than scrape
failures. They use signed payload digest rules and lack the OCI config/DiffID
chain needed by this catalog. They are rechecked at the normal scrape interval;
modern manifest and config digest mismatches remain hard failures.

`registryScraper.enabled` controls this workload independently of the source
crawler. `registryScraper.image` overrides its image; otherwise it uses
`crawler.image`. Set `registryScraper.storageClassName` for the target cluster,
or leave it unset for the cluster default, and size the claim with
`registryScraper.storageSize` (10 GiB by default). Skaffold selects the already
used `scratch` class; verify it or override it on other clusters. This catalog
retains historical image records when tags move or disappear, so old derived
images can still find their bases. `tags` lists observed aliases and
`currentTags` lists the current snapshot's aliases; they are separate from
immutable manifest/config digests. Monitor claim usage as the catalog grows.

The Base Images page shows live activity per registry: `idle`, `scraping`, or
`throttled`, with active repositories, authentication mode, latest error and
retry deadline. It refreshes every 15 seconds. HTTP 429 pauses every repository
on that registry, respecting `Retry-After` (15 minutes when absent); other
registries continue. Transient server and authentication errors also back off.
The scraper exports `driftmower_registry_state{registry,state}` and active
scrapes, HTTP request counters, completed scrape counters, last-request and
last-success timestamps, and the backoff deadline. Its PodMonitor reads port
8081; the authenticated catalog API remains on 8080.

For Docker Hub or other registry credentials, set
`registryScraper.credentialsSecretName` to a Docker-auth JSON Secret
in the release namespace (default `driftmower-dockerhub`); `credentialsSecretKey` defaults to `.dockerconfigjson`
and can be `config.json`. Docker-auth and GitHub token Secret mounts are optional:
missing Secrets allow anonymous registry access. The scraper rereads mounted
credentials on token exchanges, including after a Secret is created or rotated.
Credentials stay in mounted files, are scoped to the
registry, and are sent only to its trusted token endpoint. The scraper reuses
`crawler.githubTokenSecret` for GHCR by default, resolving the GitHub token's
owner automatically. Override `registryScraper.githubTokenSecret` or
`githubUsername` when needed. No Secret API access is granted to the scraper.

Create the Docker Hub credential Secret directly from literal JSON, replacing
the username and API token placeholders:

```bash
kubectl --context <context> --namespace driftmower \
  create secret generic driftmower-dockerhub \
  --from-literal='.dockerconfigjson={"auths":{"docker.io":{"username":"<dockerhub-username>","password":"<dockerhub-token>"}}}'
```

Set the storage class before the first deployment: StatefulSet claim templates
are immutable. If a deployment without a class was rejected on a cluster with
no default, confirm that no catalog PVC or Pod was created, delete only the
StatefulSet with `--cascade=orphan`, and redeploy with the selected class.
Changing the template does not migrate an existing PVC to another class or
resize it; manage the existing claim separately.

The default list in [chart/files/base-images.json](../chart/files/base-images.json)
covers OS, runtime and application repositories, including nginx and
`docker.dragonflydb.io/dragonflydb/dragonfly`. It scrapes every 12 hours with
two concurrent repositories. Runtime filters accept exact release tags such as
`3.13.5-alpine3.21` and `8.4.7-fpm-alpine3.21`; prereleases, signatures and broad
aliases are excluded. Repositories without numeric patch versions have their
own filters (for example Debian's `trixie-slim` and Distroless's `nonroot`).
All matching tags are considered, without a newest-N cutoff. Public registries
may impose anonymous quotas: incomplete crawls expose errors, honor Retry-After,
retain prior records and advance to unchecked tags on subsequent rounds.

Replace the whole configuration through `registryScraper.config`, or set
`registryScraper.configMapName` to an existing ConfigMap containing
`repositories.json`. A minimal configuration is:

```json
{
  "interval": "12h",
  "concurrency": 2,
  "repositories": [
    {
      "repository": "docker.io/library/nginx",
      "tagPattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-alpine[0-9.]*)?$"
    }
  ]
}
```

The directory-mounted ConfigMap reloads on scheduling rounds (at least every
minute, after Kubernetes projects the update); no Pod restart is needed.
Invalid updates retain the last valid configuration and are logged. Public
registry requests use HTTPS and public-address checks, and the scraper has no
Secret access. MCP accesses its internal API with a separately projected token
for `<release>-registry-scraper.<namespace>`, restricted to that release's MCP
ServiceAccount. Browser tokens never leave MCP for this backend.

The dashboard's **Base Images** catalog at `/base-images` reads only scraper
data. Repository pages such as
`/base-images/docker.dragonflydb.io/dragonflydb/dragonfly` show tags, platform
manifests, labels, build times, configs and ordered layers. ContainerImage
pages include a hierarchy such as
`scratch → alpine:3.21.3 → python:3.13.5-alpine3.21 → application`.
The root means the empty filesystem; each intermediate stage is an entire
catalog image matching a progressively longer ordered layer prefix. DiffIDs
allow matching across recompression. Alternative images at the same boundary
are shown together; these matches do not prove a unique Dockerfile `FROM`, and
unindexed intermediate images remain unknown.

MCP mirrors the scraper's JSON shapes through
`list_base_image_repositories`, `get_base_image_repository` (pagination and
optional manifest digest), `get_base_image_hierarchy`, and
`get_base_image_config` (the original gzip file as base64). `get_image_metadata`
includes ordered platform metadata in `platforms`, directly accepted
by the hierarchy tool as `{ "images": [...] }`. These cluster-local registry tools are
authenticated; Kubernetes image metadata remains subject to its existing
ContainerImage permissions. Queries read stored data and never trigger a
registry fetch. The scraper API exposes `GET /v1/repositories`,
`GET /v1/repository?name=...`, `POST /v1/hierarchy`, and
`GET /v1/configs/<config-digest>`.
