#!/bin/bash
EXPLORER_URL="https://driftmower-explorer.ee-lte-1.codemowers.io"
OUTPUT="$(dirname "$0")/explorer-resources.json"

curl -s "$EXPLORER_URL/api/resources" | python3 -m json.tool > "$OUTPUT"
echo "Saved to $OUTPUT"
