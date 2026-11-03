#!/usr/bin/env bash
# GET the newest report from driftmower /reports and write it to latest-report.json.
# Mirrors the query the UI sends from lib/cluster/reports.ts (fetchLatestReport).
set -euo pipefail

BASE_URL="${REPORTS_BASE_URL:-https://driftmower-be.ee-lte-1.codemowers.io}"
CLUSTER_CONTEXT="${CLUSTER_CONTEXT:-in-cluster}"
MAX_TIME="${REPORTS_MAX_TIME:-60}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${LATEST_REPORT_OUT:-$SCRIPT_DIR/latest-report.json}"

URL="$BASE_URL/reports?\$limit=1&\$sort[createdAt]=-1&clusterContext=$CLUSTER_CONTEXT"

echo "GET $URL -> $OUT" >&2
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

curl -sS --globoff --fail-with-body --max-time "$MAX_TIME" "$URL" -o "$tmp"

if ! jq -e '.data[0]' "$tmp" >/dev/null 2>&1; then
  echo "No reports found in response" >&2
  head -c 500 "$tmp" >&2
  exit 1
fi

jq '.data[0]' "$tmp" > "$OUT"
echo "Wrote $OUT (createdAt: $(jq -r '.createdAt' "$OUT"), id: $(jq -r '.id' "$OUT"))" >&2
