# Driftmower MCP

MCP server for exposing persisted Driftmower analysis snapshots to coding agents.

The server opens a Driftmower SQLite database in read-only mode and provides the
`search_workloads` MCP tool. Searches are case-insensitive substring matches over
workload names from the latest completed full-cluster report snapshot for each
cluster.

## Requirements

- Node.js 24 or compatible current LTS runtime
- A Driftmower SQLite database, usually `driftmower-be.sqlite`

## Install

```bash
npm install
npm run build
```

## Configuration

Default configuration lives in `config/default.json` and can be overridden with
environment variables:

```bash
DRIFTMOWER_MCP_DB_PATH=/data/driftmower-be.sqlite
DRIFTMOWER_MCP_TRANSPORT=stdio
DRIFTMOWER_MCP_HOST=127.0.0.1
DRIFTMOWER_MCP_PORT=3000
DRIFTMOWER_MCP_HEALTH_PORT=3001
DRIFTMOWER_MCP_DEFAULT_LIMIT=20
DRIFTMOWER_MCP_MAX_LIMIT=100
DRIFTMOWER_MCP_LOG_LEVEL=info
```

The database path can also be passed with `--db`:

```bash
driftmower-mcp --db /data/driftmower-be.sqlite
```

## Run

For local MCP clients, use the default `stdio` transport:

```bash
npm run start -- --db /data/driftmower-be.sqlite
```

For HTTP testing:

```bash
DRIFTMOWER_MCP_TRANSPORT=http npm run start -- --db /data/driftmower-be.sqlite
```

HTTP mode exposes:

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Liveness: `http://127.0.0.1:3001/healthz`
- Readiness: `http://127.0.0.1:3001/readyz`
- Startup: `http://127.0.0.1:3001/startupz`

## Local Codex MCP Registration

For local Codex usage, register this server as a `stdio` MCP server. Pass
`NODE_CONFIG_DIR` explicitly so the server can load this project's
`config/default.json` even when Codex starts it from another working directory.

Build first:

```bash
npm run build
```

Register the server:

```bash
DRIFTMOWER_MCP_DIR=/path/to/driftmower-mcp
DRIFTMOWER_DB=/path/to/driftmower-be.sqlite

codex mcp add driftmower \
  --env NODE_CONFIG_DIR="$DRIFTMOWER_MCP_DIR/config" \
  -- \
  node "$DRIFTMOWER_MCP_DIR/dist/index.js" \
  --db "$DRIFTMOWER_DB"
```

Check the registration:

```bash
codex mcp list
codex mcp get driftmower
```

Then start Codex in the repository you want to inspect or update:

```bash
codex -C /path/to/your/repository
```

Example prompt:

```text
Ask Driftmower for workloads matching memelord. Based on the snapshot data, inspect this repo and propose the config changes needed to update outdated images.
```

You can also register a running HTTP server instead of `stdio`:

```bash
codex mcp add driftmower-http --url http://127.0.0.1:3000/mcp
```

For local machine usage, `stdio` is the recommended mode. It does not require a
separate long-running server process and keeps the SQLite database path explicit.

## Tool

`search_workloads` accepts:

```json
{
  "query": "memelord",
  "limit": 20
}
```

Results include workload identity, cluster, namespace, kind, observed image or
Helm version details, latest known versions when available, and snapshot
metadata. The response represents analyzed snapshot data, not guaranteed live
cluster state.

## Development

```bash
npm run format
npm run typecheck
npm run build
npm test
```

The test suite includes repository tests, service tests, MCP transport tests, and
fixture-backed integration coverage using `test/fixtures/driftmower-be.sqlite`.
