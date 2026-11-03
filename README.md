# Driftmower

Driftmower tells Kubernetes users what runs in their cluster, how far it has
drifted from upstream releases and which advisories apply, and helps them fix
it. Every component lives in this repository:

| Directory | Component | Image |
| --- | --- | --- |
| [operator/](operator/) | Drift, advisory and image-scan operator built on nodestatd's image facts; see [operator/spec.md](operator/spec.md) | `ghcr.io/codemowers/driftmower/operator` |
| [mcp/](mcp/) | MCP server for cluster discovery, provisioning guidance, workloads and observability | `ghcr.io/codemowers/driftmower/mcp` |
| [ui/](ui/) | Next.js dashboard | `ghcr.io/codemowers/driftmower/ui` |

The operator is meant to take over the MCP server's tools one by one; see
"MCP" in the operator spec.

## Development

The operator and the MCP server share one Go module, `github.com/codemowers/driftmower`:

```bash
go vet ./...
go test -race ./...
golangci-lint run ./mcp/...
```

The dashboard has its own Node project in `ui/` (`npm ci`, `npm run lint`,
`npm test`, `npm run build`).

[Skaffold](https://skaffold.dev) builds and deploys any or all of them:

```bash
cp skaffold.env.example skaffold.env   # cluster, namespace and registry
skaffold dev                           # every component
skaffold dev -m mcp                    # one: operator, mcp or ui
```

Go images build from the repository root, where `go.mod` is; each Dockerfile
has its own `<Dockerfile>.dockerignore` beside it.

## Releases

CI builds every image from the same commit. Pushes to `main` publish `latest`
and `sha-<commit>` tags. A Git tag such as `0.9.0` publishes that version of
every image.

## History

`mcp/` and `ui/` were merged in from
[codemowers/driftmower-mcp](https://github.com/codemowers/driftmower-mcp) and
[codemowers/driftmower-ui](https://github.com/codemowers/driftmower-ui) with
their history, which `git log -- mcp/` and `git log -- ui/` show. The MCP
server's TypeScript implementation and its releases up to 0.8.0 remain in
driftmower-mcp.
