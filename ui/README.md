# Driftmower dashboard

The dashboard is a static browser application served by a small Go binary. It
queries a cluster's Go MCP endpoint directly, including live updates over MCP
subscriptions. Current inventory comes from Kubernetes CRDs and version history
from the configured Prometheus instance (global by default). No backend database, BFF, or Kubernetes
credentials are required in the dashboard.

Application tiles come from MCP's `list_oidc_clients`, which exposes public
OIDCClient metadata only after checking the caller's Kubernetes permissions.
Ingress routes are secondary inventory under **Show all hosts**. Registered
URLs are deduplicated, and internal paths do not create additional host tiles.

The **Trust** page comes from MCP's `list_trust_bundles`: every trust-manager
Bundle with its sources, the certificates distributed to the MCP's namespace,
and the mutating admission policies that mount it into Pods. CA certificates
are public, so the list is served to every signed-in user.

The **Users** page comes from `list_oidc_users` and `get_oidc_user_access`
(enabled with `mcp.userAccess.enabled`): Passmower OIDCUsers and one user's
effective rights per kind, verb and namespace. The MCP server checks the
caller's own RBAC, including impersonation for rights.

The **Groups** page is derived from the same user list: every Passmower group
(`<prefix>:<name>` as carried in tokens) with its members. GitHub-derived
groups (`github.com:<org>:<team>`) link to the organization's team page.
Users and Groups appear in navigation only when the MCP server offers
`list_oidc_users`.

**Logs** on a workload merge every Pod and container oldest first through
`query_workload_logs`; a Pod's Logs tab uses the same tool for that one Pod,
and a Namespace page for every Pod of the namespace. Lines show the container
runtime's timestamp, pod, container, severity and message: JSON, logfmt and
klog lines are split into severity, message and remaining fields, their own
timestamp dropped, and errors and warnings coloured.
With Loki, a workload is selected by the stream labels its Pods share (such as
`app` or `job`) once those are shown to select no other live Pod, so replaced
Pods are included; otherwise by its current Pod names. **Restart** calls
`restart_workload` and appears only where the server offers it.

A workload's and a Pod's memory and CPU (actual, request, limit), QoS class and
PVC space come from `get_workload_resource_usage`; their header shows the
priority class, whether Pods run in a Kata sandbox or which runtime, whether
they run as root, rootless or the image's user, and privileged containers, host
namespaces and added capabilities. The Workloads list also shows each
namespace's orphaned resources (unused ConfigMaps, Secrets, claims, Services,
Ingresses and Certificates, leftover owners and standalone Pods) in a different
colour, hidden with **Hide orphaned**; a workload's own such resources are on
its **Resources** tab.

A **Namespace** page (from the namespace in a workload's or Pod's breadcrumbs)
comes from `get_namespace_resources`: CPU and memory usage, requests and limits
of its running Pods beside its ResourceQuota, its claims' usage and capacity
beside the `requests.storage` quota, and its MinIO buckets (`<namespace>.<name>`)
with summed quotas and usage, all from Prometheus; then its workloads. The
Cluster page adds bucket usage across the cluster.

Metric figures on the Cluster, Volumes and workload pages link to Prometheus
graphs when the MCP server knows Prometheus's public address: the chart's
`mcp.prometheus.externalUrl`, or else Prometheus's own `web.external-url`.

**Settings** shows the signed-in user's own effective rights, laid out like a
user's page, from `get_my_access`: the user and groups the API server sees in
the token, evaluated without any extra permission.

The **Cluster** page comes from `get_cluster_health`: Nodes from the
Kubernetes API (roles, readiness, pressure, kubelet version), enriched from
Prometheus with TopoLVM, memory and CPU usage and per-node storage. Its alerts
panel comes from `list_alerts`, showing only the firing alerts in namespaces
the caller may read. It appears in navigation for callers who may list Nodes.

The **Volumes** page comes from `list_volumes` with unbound PVs included:
each claim as `namespace/name` with its PV and links to the Pods mounting it,
its storage class (provisioner, parameters and policies in a tooltip), node or
zone affinity, and kubelet space and inode usage, fullest first. Usage links to
a week's graph in Prometheus when Prometheus advertises its public address
(`web.external-url`, set from the Prometheus resource's `externalUrl`); without
usage metrics the space column shows the claim's capacity. PVs whose claim is
gone are greyed out under the former claim's name, with when they were
released. It appears for callers who may list PVs. The list has no resize
buttons. PVC/PV detail provides inspection and deletion commands, preferring
the PVC while it exists. Expandable PVCs have +20%, +50%, +100% command snippets;
each merge patch sets a fixed absolute size, so rerunning it does not grow the
volume again. The agent-facing `expand_volume` tool remains available.

Hosted command snippets use `ui.kubeContext` (`KUBECTL_CONTEXT`); Skaffold passes
`SKAFFOLD_KUBE_CONTEXT` unless overridden. Desktop selections retain their own
identity and namespace aliases. User settings use a single merge patch; group
edits read and filter/deduplicate the live array before patching.

Capacity bars share `MetricBar` and its usage thresholds. Area history charts
and sparklines share `TimeSeriesChart`; series colors come from the chart palette
and drift bands preserve their status colors. Page-header retries use the same
scoped inventory loader as normal dashboard refreshes.

## Desktop application

The native application lives in [desktop/](../desktop/). See the
[desktop reference](../desktop/README.md) for building, profiles and kubeconfig
configuration, or the [desktop guide](../docs/desktop.md) to get started.

## In-cluster deployment

Skaffold builds and deploys the whole application into the selected
cluster. `MCP_URL` comes from the MCP owner Secret; the server appends `/mcp`
and hides the endpoint chooser.
The same deployment includes the MCP server, crawler and scanner, with optional
dedicated Prometheus via `history.enabled=true`. The node inventory agent and its CRDs
must also be installed; see the sibling `driftmower-agent` repository.

```sh
set -a
source skaffold.env
set +a
skaffold run
```

Select a cluster by sourcing its local env file before running Skaffold:

```sh
set -a
source skaffold.env.<cluster>
set +a
skaffold run
```

All clusters use the same modules and feature settings. Local env files contain
context, namespace and build registry; they are ignored by Git. The dashboard
constructs its MCP endpoint from `OIDC_CLIENT_ORIGIN` in the MCP owner Secret.
Dashboard origins for MCP CORS come from the dashboard owner Secret, with local
origins appended. Ingress and OIDCClient short hostnames rely on cluster
admission expansion. Kaniko uses the `zot-registry-cluster-push-kaniko` Secret.

## Public runtime configuration

- `MCP_URL`: MCP public URL; `/mcp` is appended unless already present. Hides cluster selection.
- `MCP_ENDPOINTS`: JSON array of `{ "name": "cluster", "url": "https://host/mcp" }`
  entries to seed the local cluster chooser without overriding saved entries.
- `LISTEN_ADDR`: default `[::]:8080`.
- `ASSET_DIR`: default `/app/public`.

These values are read at runtime, so the same image serves any cluster. There are no server-side OAuth secrets.

## Query refresh and browser caching

Resource query hooks share `useQuery`: scope changes abort old requests, and
polling waits until the previous request completes before scheduling another.
The browser reads this cluster's crawler and registry data through its MCP.
Private crawler HTTP responses support ETag/304 validation; MCP tool calls remain
uncached. Prometheus GETs retain their private HTTP caching. No persistent JSON
cache is added to localStorage.

The **Source Repositories** page under Workloads, below Base Images, lists the
cluster's source repositories with latest releases and a single scrape status badge
containing the last scrape time. Each repository links to a detail page with
scrape errors and a paginated list of images built from it, including unused and
unversioned images. Scrape diagnostics appear on these pages rather than in the
workload advisory summary. The pages query the selected cluster's MCP and
refresh every 30 seconds. Source repository panels are omitted from
workload list/detail pages. Agent source reads remain available through
`get_workload_sources` or optional `includeSources` in workload inventory.

Namespace overview/detail views omit ContainerImage owners and terminal
Succeeded/Failed Pods, including completed Jobs. Running crash loops and broken
controllers stay visible; these filters do not modify the underlying inventory.

The Logs link in namespace, workload and Pod details shows a single aggregate
stored-log rate, averaged over five minutes. Loki performs filtering and
aggregation with LogQL; no custom log counter is needed. Loading and unavailable
states remain explicit. The namespace list has no log-rate charts. Configure
`LOKI_URL` for these reads; `LOG_RATE_*` environment settings have been removed.

License metadata comes from the pinned `ui/vendor/spdx-license-list-data` Git
submodule. Clone with `--recurse-submodules`, or run
`git submodule update --init --recursive` after checkout. `npm run build` and
`npm test` generate the compact license lookup from its `json/licenses.json`;
the dashboard makes no runtime SPDX requests. Update the submodule commit to
refresh titles and OSI approval flags. Copyleft classification covers the
recognized reciprocal license families; unrecognized/custom licenses remain
unclassified.

A private Kubernetes API may use a desktop-managed SSH jump host, recorded on
the kubeconfig **cluster**, independently of its authentication credentials:

```yaml
clusters:
  - name: talos-dev1.codemowers.io
    cluster:
      server: https://172.31.253.250:6443
      # Retain the cluster's existing CA data.
      extensions:
        - name: driftmower.codemowers.io/desktop
          extension:
            sshJumpHost: lauri@192.168.212.10
```

Existing configured SSH multiplexed connections are reused; cleanup cancels only
the desktop-owned forwarding rule and leaves the shared SSH master running.
If no master exists, Driftmower owns a separate SSH connection.

The jump host may also be an alias from `~/.ssh/config`, including its configured
ProxyJump chain. OpenSSH uses the existing SSH agent and known-host checks in
noninteractive BatchMode. Driftmower opens a loopback-only TCP forward, retains
the original Kubernetes API URL in kubeconfig and its TLS identity. The internal
transport URL uses the loopback tunnel for both REST and streaming requests, including
MCP Service port-forwarding. Tunnels are reused, restarted after SSH exits, and
closed when removed from kubeconfig or when the desktop exits. `proxy-url` and
`sshJumpHost` are mutually exclusive. Kubectl preserves the extension but does
not establish this tunnel itself.
