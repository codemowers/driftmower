#!/usr/bin/env bash
# Requires Helm, promtool and Python with PyYAML. No cluster access is used.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
task_dir=$(mktemp -d)
trap 'rm -rf -- "$task_dir"' EXIT
helm template driftmower "$root/chart" --namespace driftmower \
  --api-versions monitoring.coreos.com/v1/PrometheusRule \
  --set mcp.userAccess.enabled=true \
  --show-only templates/prometheus-rules.yaml > "$task_dir/resource.yaml"
python3 - "$task_dir" <<'PY'
from pathlib import Path
import sys
import yaml
root = Path(sys.argv[1])
resource = yaml.safe_load((root / "resource.yaml").read_text())
(root / "rules.yaml").write_text(yaml.safe_dump(resource["spec"], sort_keys=False))
PY
cp "$root/chart/tests/security-rules.test.yaml" "$task_dir/tests.yaml"
"${PROMTOOL:-promtool}" check rules "$task_dir/rules.yaml"
"${PROMTOOL:-promtool}" test rules "$task_dir/tests.yaml"
