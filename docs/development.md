# Development and releases

[Driftmower](../README.md)

The crawler and the MCP server share one Go module, `github.com/codemowers/driftmower`:

Build the frontend once before testing the desktop package:

```bash
git submodule update --init --recursive
npm --prefix ui ci
desktop/build.sh
go vet ./...
go test -race ./...
golangci-lint run ./mcp/...
```

Initialize pinned dependencies with `git submodule update --init --recursive`
before building the dashboard or its container image.

The dashboard has its own Node project in `ui/` (`npm ci`, `npm run lint`,
`npm test`, `npm run build`).

[Skaffold](https://skaffold.dev) builds and deploys all components together:

```bash
set -a
source skaffold.env.<cluster>
set +a
skaffold dev                           # every component
```

Go images build from the repository root, where `go.mod` is; each Dockerfile
has its own `<Dockerfile>.dockerignore` beside it.

## Publishing a release

A version tag such as `v0.9.3` triggers publication. The `v` prefix is required;
tags without it fail release validation. Prerelease tags such as `v0.9.3-rc.1`
produce prereleases. Branch pushes and manual runs execute
checks and build desktop artifacts without publishing a release.

CI builds the desktop natively on Linux amd64/arm64 and macOS Intel/Apple Silicon
runners. Every executable includes the built browser application. Linux builds
are statically linked; macOS builds use the operating system's libraries without
requiring Go or Node.js on the user's machine.

After tests and all image indexes pass, CI packages immutable image digests into
the chart and pushes it to `oci://ghcr.io/codemowers/charts/driftmower`. Chart
versions omit the leading `v`; appVersion retains the Git tag.

The GitHub release is published after both the desktop matrix and OCI chart
publication succeed. Its assets are:

- `driftmower-desktop-linux-amd64`
- `driftmower-desktop-linux-arm64`
- `driftmower-desktop-darwin-amd64` (Intel Mac)
- `driftmower-desktop-darwin-arm64` (Apple Silicon)
- `driftmower-<version>.tgz`
- `SHA256SUMS`

New releases remain drafts until uploads complete. Reruns upload missing assets
and verify matching existing assets; they refuse to replace a published asset
with different bytes. Use a new tag for changed artifacts.

GitHub Releases uses the workflow's `contents: write` permission; GHCR publishing
uses `packages: write`. The chart and component images need public GHCR package
visibility for anonymous pulls; making the source repository public does not
change existing package visibility. See [GitHub package visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

The publishing workflow is defined in [.github/workflows/ci.yml](../.github/workflows/ci.yml).
