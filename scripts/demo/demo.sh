#!/usr/bin/env bash
# Records the dashboard demo with narration from an in-cluster TTS service
# (Orpheus by default; Piper with --tts-service piper-tts --tts-secret
# piper-tts-api-token --voice en_US-lessac-medium), reached through a temporary
# kubectl port-forward with your own kubeconfig credentials. The TTS token is
# passed by environment only.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/demo/demo.sh --context KUBE_CONTEXT --url DASHBOARD_URL [login|record] [record.mjs options]

  --context        kube context of the cluster that runs the TTS service (required for narration)
  --url            dashboard URL, e.g. https://dashboard.driftmower.<cluster-domain>
  --tts-namespace  namespace of the TTS Service        (default: llm)
  --tts-service    TTS Service name, port 8080         (default: orpheus-tts)
  --tts-secret     Secret with the bearer token        (default: llama-api-token, key "token")
  --voice          narration voice, after record       (Orpheus default: leo)
  --no-tts         record captions only
EOF
  exit 2
}

dir=$(cd "$(dirname "$0")" && pwd)
context="" url="" ns=llm svc=orpheus-tts secret=llama-api-token tts=1 rest=()
while (($#)); do
  case $1 in
    --context) context=$2; shift 2 ;;
    --url) url=$2; shift 2 ;;
    --tts-namespace) ns=$2; shift 2 ;;
    --tts-service) svc=$2; shift 2 ;;
    --tts-secret) secret=$2; shift 2 ;;
    --no-tts) tts=0; shift ;;
    -h|--help) usage ;;
    *) rest+=("$1"); shift ;;
  esac
done
[[ -n $url ]] || usage
mode=${rest[0]:-record}

[[ -d $dir/node_modules/playwright-core ]] || npm --prefix "$dir" ci --no-audit --no-fund
# Playwright records video with its own ffmpeg build (no browser download).
compgen -G "$HOME/.cache/ms-playwright/ffmpeg-*" >/dev/null || node "$dir/node_modules/playwright-core/cli.js" install ffmpeg

if [[ $mode == record && $tts == 1 ]]; then
  [[ -n $context ]] || { echo "--context is required for narration (or pass --no-tts)" >&2; exit 2; }
  DEMO_TTS_TOKEN=$(kubectl --context "$context" -n "$ns" get secret "$secret" -o jsonpath='{.data.token}' | base64 -d)
  export DEMO_TTS_TOKEN
  log=$(mktemp)
  kubectl --context "$context" -n "$ns" port-forward "svc/$svc" :8080 >"$log" 2>&1 &
  pf=$!
  trap 'kill $pf 2>/dev/null; rm -f "$log"' EXIT
  for _ in $(seq 50); do
    port=$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$log" | head -1)
    [[ -n $port ]] && break
    kill -0 $pf 2>/dev/null || { cat "$log" >&2; exit 1; }
    sleep 0.2
  done
  [[ -n ${port:-} ]] || { echo "TTS port-forward did not start" >&2; cat "$log" >&2; exit 1; }
  export DEMO_TTS_URL="http://127.0.0.1:$port"
  [[ $svc == orpheus-tts ]] && export DEMO_TTS_VOICE=${DEMO_TTS_VOICE:-leo}
fi

# Reuse the Chrome profile the desktop app assigned to this context's auth entry.
if [[ -z ${DEMO_CHROME_PROFILE:-} && -n $context ]]; then
  DEMO_CHROME_PROFILE=$(kubectl config view -o json | node -e '
    const c = JSON.parse(require("fs").readFileSync(0, "utf8")), name = process.argv[1]
    const user = c.contexts?.find(x => x.name === name)?.context?.user
    const ext = c.users?.find(u => u.name === user)?.user?.extensions?.find(e => e.name === "driftmower.codemowers.io/desktop")
    process.stdout.write(ext?.extension?.chromeProfile?.directory ?? "")' "$context")
  export DEMO_CHROME_PROFILE
fi

node "$dir/record.mjs" --url "$url" "${rest[@]}"
