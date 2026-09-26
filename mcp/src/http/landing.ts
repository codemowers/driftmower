import { Marked } from 'marked'
import { clusterIdentity, type ClusterIdentity } from '../domain/cluster-identity.js'
import type { EngineeringAdvisory } from '../advisory/software-engineering.js'
import { ENGINEERING_ADVISORIES } from '../advisory/software-engineering.js'

const taglines = [
  'We take the oops out of DevOps.',
  'AI TERK ER JERBS!',
  'Keeping software architects unemployed since 2026.',
  'The software architect has been evicted.',
  'Your architecture review could have been a linter.',
  'Microservices. Macroproblems.',
  'YAML is a terrible thing to waste.',
  'Reconciliation is cheaper than therapy.',
  'Scale horizontally. Panic vertically.',
  'Cloud native. Budget hostile.',
  'Five nines. Six therapists.',
  'Desired state: employed.',
  'Have you tried deleting the pod?',
  'It works on my cluster.',
  'No gods. No masters. Just controllers.',
  'This meeting could have been a ConfigMap.',
  'We replaced the architect with a reconciliation loop.',
  'Your job is pending. Insufficient resources.',
  'Powered by spite and declarative configuration.'
]

const zen = [
  'Don’t redefine defaults.',
  'One process per container. One responsibility per workload.',
  'Let Kubernetes orchestrate.',
  'State belongs in deliberate storage, not the container filesystem.',
  'Secrets belong in secret stores, never in images.',
  'Logs are streams. Metrics describe the application.',
  'Exceptions deserve evidence, not imitation.',
  'Readiness should be cheap; liveness should earn its place.',
  'Single sign-on is not an enterprise feature.',
  'Unexpected failures should be loud.',
  'Retries must tolerate repetition.',
  'Trust must be verified, even inside the cluster.',
  'Discover platform policy before duplicating it.',
  'Build once. Promote the same image.',
  'Releases are immutable; running containers are disposable.',
  'Shutdown is part of startup’s promise.',
  'A retained volume is not a backup.',
  'Listen beyond IPv4.',
  'Use admission mutation policies to enforce cluster-wide patterns.',
  'An application release should not own its namespace.'
]

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!
  })
}

function advisoryRenderer(advisories: EngineeringAdvisory[]) {
  const advisoryPaths = new Set(advisories.map(section => section.path))

  return new Marked({
    renderer: {
      codespan({ text }) {
        if (!advisoryPaths.has(text)) return false

        return `<a href="#${escapeHtml(text)}"><code>${escapeHtml(text)}</code></a>`
      },
      html({ text }) {
        return escapeHtml(text)
      },
      link(token) {
        if (!/^(https?:\/\/|#)/i.test(token.href)) return this.parser.parseInline(token.tokens)

        return false
      }
    }
  })
}

export function renderAdvisoryText(
  text: string,
  advisories: EngineeringAdvisory[] = ENGINEERING_ADVISORIES
): string {
  return advisoryRenderer(advisories).parse(text, { async: false }).trimEnd()
}

export function renderLandingPage(
  authenticated: boolean,
  endpoint: string,
  options: {
    cluster?: ClusterIdentity
    advisories?: EngineeringAdvisory[]
    oauthClientId?: string | null
  } = {}
): string {
  const advisories = options.advisories ?? ENGINEERING_ADVISORIES
  const cluster = options.cluster ?? clusterIdentity(null, null, endpoint)
  const serverName = cluster.mcpServerName

  const shellUrl = "'" + endpoint.replaceAll("'", "'\"'\"'") + "'"
  const clientId = options.oauthClientId
  const shellClientId = clientId ? "'" + clientId.replaceAll("'", "'\"'\"'") + "'" : null
  const claude = `claude mcp add --transport http --scope user${authenticated && shellClientId ? ` --client-id ${shellClientId}` : ''} ${serverName} ${shellUrl}`
  const codex = `codex mcp add ${serverName} --url ${shellUrl}${authenticated && shellClientId ? ` --oauth-client-id ${shellClientId}` : ''}`
  const config = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          type: 'http',
          url: endpoint,
          ...(authenticated && clientId ? { oauth: { clientId } } : {})
        }
      }
    },
    null,
    2
  )

  const categories = [
    ...new Set([
      'developing',
      'building',
      'deploying',
      ...advisories.map(section => section.path.split('/')[0])
    ])
  ]
  const sections = categories
    .map(category => {
      const categoryAdvisories = advisories
        .filter(section => section.path.split('/')[0] === category)
        .sort((a, b) => Number(b.path.endsWith('/general')) - Number(a.path.endsWith('/general')))

      return `<section><h2>${escapeHtml(category[0].toUpperCase() + category.slice(1))}</h2>${categoryAdvisories
        .map(
          section =>
            `<article id="${escapeHtml(section.path)}"><h3>${escapeHtml(section.title)}</h3>${section.source === 'override' ? '<p class="advisory-source">Cluster override</p>' : ''}${renderAdvisoryText(section.text, advisories)}</article>`
        )
        .join('\n')}</section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zen of Kubernetes</title>
<style>
:root { color-scheme: light dark; --paper: #f6f4ed; --ink: #222c29; --muted: #65716a; --accent: #287258; --line: #d5dcd2; --panel: #eaece4; font-family: system-ui, sans-serif; line-height: 1.75; background: var(--paper); color: var(--ink); }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 880px; padding: 5rem 1.5rem 2rem; }
header { padding-bottom: 1rem; }
h1, h2, h3 { line-height: 1.2; text-wrap: balance; }
h1 { font-family: Georgia, serif; font-weight: 400; font-size: clamp(2.8rem, 7vw, 4.8rem); letter-spacing: -.055em; margin: 0 0 1rem; }
h2 { margin: 0 0 2rem; font-size: 1.8rem; letter-spacing: -.035em; }
h3 { margin: 2rem 0 1rem; font-size: 1.2rem; }
section { border-top: 1px solid var(--line); margin-top: 3.5rem; padding-top: 3rem; }
li { margin-block: .7rem; padding-left: .2rem; }
li::marker { color: var(--accent); }
a { color: var(--accent); text-underline-offset: .25em; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 5px; border-radius: 2px; }
article { scroll-margin-top: 2rem; padding-bottom: 1rem; }
article + article { border-top: 1px dashed var(--line); padding-top: 1rem; margin-top: 1rem; }
code { font-size: .88em; background: var(--panel); padding: .15em .35em; border-radius: .25rem; overflow-wrap: anywhere; }
pre { padding: 1.25rem; background: var(--panel); border: 1px solid var(--line); border-radius: .65rem; overflow-x: auto; line-height: 1.6; }
pre code { padding: 0; background: none; overflow-wrap: normal; }
blockquote { border-left: 3px solid var(--accent); margin-left: 0; padding-left: 1.5rem; color: var(--muted); }
table { display: block; overflow-x: auto; border-collapse: collapse; }
th, td { padding: .6rem 1rem; border: 1px solid var(--line); text-align: left; }
.zen { list-style: none; margin: 3rem 0 0; padding: 0 0 0 1.5rem; border-left: 2px solid var(--accent); font-family: Georgia, serif; font-size: clamp(1.05rem, 2.5vw, 1.25rem); font-style: italic; }
.zen li { margin-block: .45rem; padding: 0; }
.taglines { display: grid; color: var(--muted); font-size: .95rem; }
.taglines span { grid-area: 1 / 1; opacity: 0; animation: tagline ${taglines.length * 6}s infinite; }
@keyframes tagline { 0%, ${(100 * 5) / (taglines.length * 6)}% { opacity: 1; } ${100 / taglines.length}%, 100% { opacity: 0; } }

footer { display: flex; justify-content: center; align-items: center; gap: 1rem; flex-wrap: wrap; margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
footer a { display: inline-flex; align-items: center; gap: .6rem; overflow-wrap: anywhere; }
footer svg { flex-shrink: 0; }
@media (prefers-color-scheme: dark) { :root { --paper: #151d19; --ink: #e0e6dc; --muted: #a4b1a7; --accent: #9dcca9; --line: #34443a; --panel: #202c25; } }
@media (max-width: 540px) { body { padding: 2.5rem 1rem 1.5rem; } .zen { padding-left: 1rem; } }
@media (prefers-reduced-motion: reduce) { .taglines span { animation: none; } .taglines span:first-child { opacity: 1; } }
@media print { :root { --paper: white; --ink: black; --muted: #444; --accent: #333; --line: #ccc; --panel: #eee; } body { max-width: none; padding: 0; } h2, h3 { break-after: avoid; } .taglines span { animation: none; } .taglines span:first-child { opacity: 1; } }
</style>
</head>
<body>
<header><h1>Zen of Kubernetes</h1>
<div class="taglines" aria-label="We take the oops out of DevOps.">
${taglines.map((line, index) => `<span aria-hidden="true" style="animation-delay: ${index * 6}s">${escapeHtml(line)}</span>`).join('\n')}
</div>
<ul class="zen">${zen.map(line => `<li>${escapeHtml(line)}</li>`).join('\n')}</ul>
</header>
<section><h2>Using this server</h2>
<p>Cluster: <code>${escapeHtml(cluster.id ?? 'Not configured')}</code><br>
Kubernetes API: <code>${escapeHtml(cluster.apiUrl ?? 'Not configured — confirm the target context before using kubectl')}</code></p>
<h3>Claude Code</h3>
<pre><code>${escapeHtml(claude)}</code></pre>
${authenticated ? '<p>Run <code>/mcp</code> in Claude Code and select this server to sign in.</p>' : ''}
<h3>Codex</h3>
<pre><code>${escapeHtml(codex)}</code></pre>
<h3>Claude Code project config — .mcp.json</h3>
<pre><code>${escapeHtml(config)}</code></pre>
<h3>Other MCP clients</h3>
<pre><code>${escapeHtml(`Transport: Streamable HTTP\nURL: ${endpoint}${authenticated && clientId ? `\nOAuth client ID: ${clientId}` : ''}`)}</code></pre>
</section>
${sections}
<footer>
<a href="https://github.com/codemowers/driftmower-mcp" aria-label="Source on GitHub: codemowers/driftmower-mcp">
<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.763-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.469-2.381 1.236-3.221-.123-.303-.536-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.52 11.52 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.655 1.652.243 2.873.12 3.176.77.84 1.235 1.911 1.235 3.221 0 4.61-2.805 5.625-5.478 5.921.431.372.816 1.102.816 2.222 0 1.606-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.597 24 12.297c0-6.627-5.373-12-12-12"/></svg>
codemowers/driftmower-mcp</a></footer>
</body>
</html>`
}
