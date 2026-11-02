# TypeScript reference captures

Review material for the Go rewrite. These files record what the TypeScript
server exposed before it was replaced; they are not golden files, and the Go
server may deliberately differ.

- `ts-stdio-catalog.json`: `initialize`, `tools/list` and `resources/list` from
  the stdio transport with the backend enabled. Observability and workload
  restart tools only register on authenticated HTTP and are absent here.

Regenerate from a checkout that still has the TypeScript sources:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ref","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"resources/list"}' |
  DRIFTMOWER_BE_SERVICE_TOKEN=reference KUBERNETES_TOKEN_FILE=/dev/null \
  KUBERNETES_CA_FILE=/dev/null npx tsx src/index.ts
```
