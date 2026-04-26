#!/usr/bin/env bash
# POST to driftmower analyze-cluster; response can take several minutes.
set -euo pipefail

URL="${ANALYZE_CLUSTER_URL:-https://driftmower-be.ee-lte-1.codemowers.io/analyze-cluster}"
# Allow long runs (default 10 minutes; override e.g. ANALYZE_MAX_TIME=900)
MAX_TIME="${ANALYZE_MAX_TIME:-600}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${ANALYZE_OUT:-$SCRIPT_DIR/analyze-cluster.json}"

echo "POST $URL (max time ${MAX_TIME}s) -> $OUT" >&2
curl -sS --fail-with-body \
  --max-time "$MAX_TIME" \
  -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -d '{}' \
  -o "$OUT"

echo "Wrote $OUT" >&2
