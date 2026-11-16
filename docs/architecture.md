# Components

[Driftmower](../README.md)

Driftmower runs one installation per cluster. The browser and agents query that
cluster's MCP endpoint; crawler and registry data remain local to the cluster.

| Directory | Component | Image |
| --- | --- | --- |
| [crawler/](../crawler/) | Releases, changelogs, source licenses and security advisories | `ghcr.io/codemowers/driftmower-crawler` |
| [mcp/](../mcp/) | Kubernetes discovery, access checks, observability and MCP tools | `ghcr.io/codemowers/driftmower-mcp` |
| [operator/](../operator/) | Image scan scheduling and retained SBOM cache | `ghcr.io/codemowers/driftmower-operator` |
| [ui/](../ui/) | Browser dashboard | `ghcr.io/codemowers/driftmower-ui` |

The native application lives in [desktop/](../desktop/) and serves the same browser
assets locally. Its dashboard package also supplies the hosted static server.

The registry scraper runs independently using the crawler image's `registry`
command. Shared Go code lives in [internal/](../internal/). Deployment manifests
and configuration defaults live in [chart/](../chart/).

Component references: [MCP configuration](../mcp/README.md),
[dashboard reference](../ui/README.md), [registry scraper](registry.md), and
[metrics and scan semantics](observability.md).
