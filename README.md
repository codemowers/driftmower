# Driftmower

**A Kubernetes dashboard that connects the dots.**

Think Lens on steroids: cluster exploration with image ancestry, vulnerability
findings, source advisories, storage and access rights brought into the same
picture. Driftmower helps you understand what is running, what needs attention,
and where to act.

Follow a workload through its Pods, container images, source repositories,
security findings, logs and volumes. See the affected resources together,
instead of piecing the answer together across dashboards and terminal output.
Less context switching. Less cognitive load. More time to fix the actual problem.

## See the whole workload

- **Workloads, connected.** Consolidated cluster, namespace, workload and Pod
  views show ownership, dependencies, resource usage and related resources.
- **Images beyond the tag.** Inspect immutable digests, platform variants, build
  timestamps, source repositories, licenses and base image ancestry. Track how
  far deployed images have drifted from upstream releases.
- **Security findings with impact.** CVEs and GitHub Security Advisories (GHSAs)
  link to affected images and workloads. Prioritize by score and severity, see
  scan coverage, and follow security trends over time.
- **Storage you can make sense of.** Explore PersistentVolumes and
  PersistentVolumeClaims (PVs/PVCs) together: bindings, capacity, usage, placement
  and reclaim policy. Identify unused storage and get copyable cleanup or
  resize commands.
- **RBAC you can interpret.** Inspect users, groups, ServiceAccounts and their
  effective permissions. Understand who can access what, in which namespace,
  and identify broad permissions worth reviewing.
- **Operations in context.** CPU, memory, network and disk I/O, logs and firing
  alerts sit alongside the resources they describe. Executive Summary brings
  firing alerts together as prioritized action items.

## From understanding to action

Driftmower provides copyable commands for inspection, upgrades and cleanup,
with explicit Kubernetes contexts and namespaces. You can see the command
before running it, without reconstructing it from resource details.

Use the browser dashboard or native desktop application. Agents can query the
same cluster through MCP to inspect workloads, resource usage, security findings
and operational signals. Kubernetes RBAC governs access by default.

## Install in a cluster

Configure authentication, monitoring and storage for your cluster using the
[deployment guide](docs/deployment.md), then install the Helm chart into an
existing namespace:

```sh
helm upgrade --install driftmower oci://ghcr.io/codemowers/charts/driftmower \
  --namespace driftmower -f values.yaml
```

Open the deployed dashboard, or connect through the desktop application.
See [access configuration](docs/deployment.md#access-modes) for authentication options.

## Run the desktop application

Download the executable for Linux, Intel Mac or Apple Silicon from
[GitHub Releases](https://github.com/codemowers/driftmower/releases), make it
executable and run it. The UI is included; Chrome or Chromium and your kubeconfig
are all you need, plus any authentication tools your kubeconfig uses. See the
[desktop installation guide](desktop/README.md) for platform details.

To build from a source checkout with Go and Node.js installed:

```sh
git submodule update --init --recursive
npm --prefix ui ci
desktop/build.sh
desktop/build/driftmower-desktop
```

The application opens a Chrome or Chromium window. In **Settings**, select a
kubeconfig connection and click **Connect**; use **Sign in** when prompted.
If MCP has no Ingress, the desktop connects using an automatic port-forward.
Use `--status` to see its PID, `--stop` to stop it, or `--restart` to restart.
See the [desktop guide](docs/desktop.md) for Chrome profiles and connection details.

## Documentation

- [Deployment and access](docs/deployment.md): Helm configuration, storage and authentication.
- [Desktop dashboard](docs/desktop.md): connections, profiles and command snippets.
- [Registry scraper](docs/registry.md): credentials, repositories and base image matching.
- [Metrics and alerts](docs/observability.md): scan coverage, history and metric definitions.
- [Components](docs/architecture.md): services and component references.
- [Development and releases](docs/development.md): local builds, Skaffold, tests and publishing.
