import { readFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface WebUiOptions {
  issuer: string
  clientId: string
  resource: string
}

export async function handleWebUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  options: WebUiOptions
): Promise<boolean> {
  if (!['/ui', '/ui/', '/ui/callback', '/ui/config', '/ui/explorer.js'].includes(path)) return false

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()

    return true
  }

  let body: string
  let contentType = 'text/html; charset=utf-8'

  if (path === '/ui/config') {
    contentType = 'application/json'
    body = JSON.stringify(options)
  } else if (path === '/ui/explorer.js') {
    contentType = 'text/javascript; charset=utf-8'
    body = await readFile(new URL('../../dist/web/explorer.js', import.meta.url), 'utf8')
  } else {
    body = renderWebUi(path === '/ui/callback')
  }

  const issuerOrigin = new URL(options.issuer).origin

  response.writeHead(200, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    // The popup must retain its opener across the provider redirect.
    'cross-origin-opener-policy': 'unsafe-none',
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ${issuerOrigin}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
  })
  response.end(request.method === 'HEAD' ? undefined : body)

  return true
}

export function renderWebUi(callback = false): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Explorer · Driftmower</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; --bg:#f5f6f2; --panel:#fff; --ink:#202e29; --muted:#63726b; --line:#dce3dc; --accent:#237353; background:var(--bg); color:var(--ink) }
* { box-sizing:border-box } body { margin:0 } a { color:var(--accent) } button,select,textarea,input { font:inherit }
button { cursor:pointer; border:1px solid var(--line); border-radius:7px; padding:.65rem .9rem; background:var(--panel); color:var(--ink) } button:hover { border-color:var(--accent) } button:disabled { opacity:.5; cursor:default }
button.primary { background:var(--accent); color:white; border-color:var(--accent) } :focus-visible { outline:2px solid var(--accent); outline-offset:3px }
header { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:1.5rem 2rem; border-bottom:1px solid var(--line); background:var(--panel) } header h1 { font-size:1.3rem; margin:0 } header small { color:var(--muted) }
.auth { display:flex; align-items:center; gap:1rem; flex-wrap:wrap } main { display:grid; grid-template-columns:220px minmax(0,1fr); max-width:1600px; margin:auto; min-height:80vh }
nav { padding:2rem 1rem; display:flex; flex-direction:column; gap:.45rem; border-right:1px solid var(--line) } nav button { text-align:left; background:transparent; border-color:transparent } nav button[aria-current="page"] { background:var(--panel); border-color:var(--line); color:var(--accent) } nav a { margin:1rem .9rem }
#usage-summary { white-space:pre-line } article { padding:2rem; min-width:0 } h2 { margin-top:0; font-size:1.7rem } .muted { color:var(--muted); line-height:1.6 } #status { margin:1rem 0; white-space:pre-wrap; overflow-wrap:anywhere } #status[data-error="true"] { color:#bd483c }
.toolbar { display:flex; gap:.8rem; align-items:center; flex-wrap:wrap; margin:1rem 0 } .toolbar input { flex:1; min-width:160px } select,input,textarea { padding:.65rem; border:1px solid var(--line); border-radius:7px; background:var(--panel); color:var(--ink) }
textarea { display:block; width:100%; min-height:130px; font-family:monospace; resize:vertical } pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:.85rem; line-height:1.6; padding:1rem; background:var(--panel); border:1px solid var(--line); border-radius:7px }
.table-wrap { overflow:auto; background:var(--panel); border:1px solid var(--line); border-radius:9px } table { width:100%; border-collapse:collapse; font-size:.9rem } th,td { padding:.85rem 1rem; text-align:left; vertical-align:top; border-bottom:1px solid var(--line); max-width:500px; overflow-wrap:anywhere; white-space:pre-wrap } th { color:var(--muted); font-size:.8rem; background:var(--bg) } tr:last-child td { border-bottom:0 }
.markdown { white-space:normal; line-height:1.6 } .markdown > :first-child { margin-top:0 } .markdown > :last-child { margin-bottom:0 } .markdown p,.markdown ul,.markdown ol,.markdown blockquote { margin:.6rem 0 } .markdown ul,.markdown ol { padding-left:1.5rem } .markdown code { font-size:.9em; background:var(--bg); padding:.1rem .25rem; border-radius:3px } .markdown pre code { padding:0; background:transparent } .markdown blockquote { border-left:3px solid var(--line); padding-left:1rem } .markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6 { font-size:1em; margin:.8rem 0 .4rem }
.workload-owner { border:1px solid var(--line); border-radius:9px; padding:1rem; background:var(--panel) } .workload-owner > summary { color:var(--ink); font-weight:600; overflow-wrap:anywhere } .workload-owner pre { margin-bottom:0 }
.badge { display:inline-block; padding:.2rem .6rem; border-radius:20px; background:var(--panel); border:1px solid var(--line); font-size:.8rem } details { margin:1rem 0 } summary { cursor:pointer; color:var(--muted) } [hidden] { display:none !important }
@media(prefers-color-scheme:dark) { :root { --bg:#15221c; --panel:#1d2d24; --ink:#e3ebe4; --muted:#a1b3a7; --line:#354b3d; --accent:#69bc90 } button.primary { color:#122219 } }
@media(max-width:750px) { header { padding:1rem; flex-wrap:wrap } main { grid-template-columns:1fr } nav { flex-direction:row; flex-wrap:wrap; padding:.7rem; border-right:0; border-bottom:1px solid var(--line) } nav a { margin:.6rem } article { padding:1rem } }
</style></head><body>
${
  callback
    ? '<main><article><h1>Completing sign-in…</h1><p id="status" role="status"></p></article></main>'
    : `
<header><div><h1>MCP Explorer</h1><small>Driftmower · live cluster discovery</small></div><div class="auth"><span id="identity" class="muted">Not signed in</span><button id="signin" class="primary" disabled>Sign in with OpenID</button><button id="signout" hidden>Forget credentials</button></div></header>
<main><nav aria-label="Explorer views">
<button data-view="namespaces" aria-current="page">Accessible namespaces</button><button data-view="workloads">Workloads</button><button data-view="policies">Admission policies</button><button data-view="crds">Custom resource definitions</button><button data-view="ingress">Ingress classes</button><button data-view="issuers">Cluster issuers</button><button data-view="priorities">Priority classes</button><button data-view="storage">Storage classes</button><button data-view="clusterUsage">Cluster resource usage</button><button data-view="podUsage">Pod resource usage</button><button data-view="tools">Tool explorer</button>
<a href="/">Connection instructions</a><a href="https://mcp.codemowers.io">General guidance ↗</a>
</nav><article>
<h2 id="heading">Accessible namespaces</h2><div id="description" class="muted">Sign in to ask the cluster authorizer which namespaces you can inspect.</div>
<p id="status" role="status" aria-live="polite">Sign in to connect to this MCP server.</p>
<section id="tool-editor" hidden><label for="tool">MCP tool</label><div class="toolbar"><select id="tool"></select></div><div id="tool-description" class="muted"></div><details><summary>Input schema</summary><pre id="schema"></pre></details><label for="arguments">Arguments (JSON)</label><textarea id="arguments" spellcheck="false">{}</textarea></section>
<section id="target-pickers" class="query-controls" hidden><div class="toolbar"><label id="namespace-field">Namespace <input id="namespace" list="namespace-options" autocomplete="off" placeholder="Select or enter namespace"></label><datalist id="namespace-options"></datalist><label id="pod-field">Pod name <input id="pod" list="pod-options" autocomplete="off" placeholder="Select or enter pod name"></label><datalist id="pod-options"></datalist><button id="reload-targets" type="button">Reload choices</button></div><p id="picker-status" class="muted" role="status"></p></section>
<section id="usage-controls" class="query-controls" hidden><div class="toolbar"><label>Rate interval <select id="rate-window"><option value="60">1 minute</option><option value="300" selected>5 minutes</option><option value="900">15 minutes</option><option value="3600">1 hour</option></select></label><label id="breakdown-field"><input id="usage-breakdown" type="checkbox"> <span id="breakdown-label">Per-node breakdown</span></label><label><input id="usage-history" type="checkbox"> Historical analysis</label><span id="history-window-field" hidden><label for="history-window">History window</label> <select id="history-window"><option value="900">15 minutes</option><option value="3600" selected>1 hour</option><option value="21600">6 hours</option><option value="86400">24 hours</option></select></span></div></section>
<p id="usage-summary" class="muted" hidden></p>
<div class="toolbar"><input id="filter" aria-label="Filter results" placeholder="Filter results…" hidden><button id="run" disabled>Refresh</button><span id="count" class="badge" hidden></span></div>
<div id="result"></div><details id="raw" hidden><summary>Raw MCP result</summary><pre id="raw-result"></pre></details>
</article></main>`
}
<script type="module" src="/ui/explorer.js"></script></body></html>`
}
