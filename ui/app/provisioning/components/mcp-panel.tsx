"use client"

import { useEffect, useState } from "react"
import { Eye, EyeOff, KeyRound, TriangleAlert } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import { cn } from "@/lib/utils/cn"
import {
  maskSnippet,
  mcpQuickstarts,
  type McpClientId,
  type Snippet,
} from "@/lib/features/provisioning/mcp-quickstarts"

// Connect a coding agent to the MCP gateway.
//
// The gateway answers the same questions this page does, plus the drift
// analysis — so an agent can ask "what will bite me in this namespace" without
// a person relaying the page. The hard part is never the tool list, it is
// getting a token into the client, which is what this panel is for.

type ConfigState =
  | { status: "loading" }
  | { status: "unconfigured"; reason: string }
  | { status: "ready"; mcpUrl: string; clientId: string | null }

type TokenState =
  | { status: "idle" }
  | { status: "minting" }
  | { status: "error"; message: string; hint?: string }
  // A session that predates MCP being enabled carries no grant for the MCP
  // audience. Nothing is broken and no administrator is needed — the user just
  // has to sign in again — so it gets its own state with the fix attached
  // rather than being rendered as a failure.
  | { status: "needs-reauth"; hint: string }
  | { status: "ready"; token: string; expiresInMinutes: number }

export default function McpPanel() {
  const [config, setConfig] = useState<ConfigState>({ status: "loading" })
  const [token, setToken] = useState<TokenState>({ status: "idle" })
  const [client, setClient] = useState<McpClientId>("claude-code")
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch("/api/mcp/config", { cache: "no-store" })
      .then(async res => {
        if (cancelled) return
        const body = await res.json()

        if (!res.ok) {
          setConfig({ status: "unconfigured", reason: body.detail ?? `Request failed (${res.status})` })
          return
        }
        if (!body.enabled) {
          setConfig({
            status: "unconfigured",
            reason:
              "MCP is not enabled on this deployment. Until MCP_ENABLED is set, login does not request the MCP resource, so no token for the gateway can be issued.",
          })
          return
        }
        if (!body.mcpUrl) {
          setConfig({
            status: "unconfigured",
            reason: "No public URL is configured for the MCP gateway (MCP_PUBLIC_URL).",
          })
          return
        }

        setConfig({ status: "ready", mcpUrl: body.mcpUrl, clientId: body.clientId })
      })
      .catch(e => {
        if (!cancelled) setConfig({ status: "unconfigured", reason: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (config.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  if (config.status === "unconfigured") {
    return <p className="text-sm text-muted-foreground">{config.reason}</p>
  }

  // Minting is an explicit click, never on page load: the response is a
  // credential, and a page that hands one out just for being opened leaves it
  // in memory and in the network log of anyone who never wanted it.
  async function mintToken() {
    setToken({ status: "minting" })

    try {
      const res = await fetch("/api/mcp/token", { cache: "no-store" })
      // Not necessarily JSON: a proxy or CDN in front of this app can replace
      // an error response with an HTML page of its own, and `res.json()` would
      // then throw a parse error that tells the reader nothing about what
      // actually failed.
      const raw = await res.text()
      let body: Record<string, unknown>

      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        setToken({
          status: "error",
          message: `The server returned a ${res.status} that was not JSON, so something between this page and the app replaced the response.`,
          hint: "Check the driftmower-ui logs for a line starting [mcp].",
        })
        return
      }

      if (body.action === "reauthenticate") {
        setToken({
          status: "needs-reauth",
          hint: String(body.hint ?? "Sign in again to get an MCP token."),
        })
        return
      }

      if (!res.ok) {
        setToken({
          status: "error",
          message: String(body.detail ?? body.error ?? "Could not mint a token"),
          hint: typeof body.hint === "string" ? body.hint : undefined,
        })
        return
      }

      setToken({
        status: "ready",
        token: String(body.accessToken),
        expiresInMinutes: Math.max(1, Math.round(Number(body.expiresIn ?? 3600) / 60)),
      })
      setRevealed(false)
    } catch (e) {
      setToken({ status: "error", message: String(e) })
    }
  }

  const activeToken = token.status === "ready" ? token.token : null
  const quickstarts = mcpQuickstarts({ mcpUrl: config.mcpUrl, token: activeToken, clientId: config.clientId })
  const active = quickstarts.find(q => q.id === client) ?? quickstarts[0]

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 shrink-0 text-brand-icon" />
            <code className="font-mono text-sm text-foreground">{config.mcpUrl}</code>
            <span className="relative z-10">
              <CopyButton value={config.mcpUrl} />
            </span>
          </div>

          <button
            type="button"
            onClick={mintToken}
            disabled={token.status === "minting"}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            {token.status === "minting"
              ? "Getting a token…"
              : token.status === "ready"
                ? "Get a new token"
                : "Get a token"}
          </button>
        </div>

        {token.status === "error" && (
          <p className="mt-3 text-sm text-status-major">
            {token.message}
            {token.hint ? ` ${token.hint}` : null}
          </p>
        )}

        {token.status === "needs-reauth" && (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-status-minor-label">
            <TriangleAlert className="size-4 shrink-0" />
            <span>{token.hint}</span>
            {/* returnTo brings them back here rather than to the home page,
                so the next click is the one they wanted in the first place. */}
            <a
              href="/api/auth/login?returnTo=%2Fprovisioning"
              className="font-medium text-brand-text underline underline-offset-2"
            >
              Sign in again
            </a>
          </p>
        )}

        {token.status === "ready" && (
          <p className="mt-3 flex items-start gap-2 text-sm text-status-minor-label">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              This token expires in about {token.expiresInMinutes} minutes and cannot be refreshed by a
              client that was given it as a header. Treat it like a password.
              {active.oauth
                ? " For a connection that keeps working, use the OAuth flow below instead."
                : null}
            </span>
          </p>
        )}

        {token.status === "idle" && (
          <p className="mt-3 text-sm text-muted-foreground">
            The commands below need a token. Get one when you are ready to paste it somewhere.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {quickstarts.map(quickstart => (
          <button
            key={quickstart.id}
            type="button"
            onClick={() => setClient(quickstart.id)}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors",
              quickstart.id === client
                ? "border-b-2 border-brand text-brand-text"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {quickstart.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Paste a token
            </h3>
            {activeToken && (
              <button
                type="button"
                onClick={() => setRevealed(r => !r)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {revealed ? "Hide token" : "Show token"}
              </button>
            )}
          </div>

          {active.paste.map((snippet, i) => (
            <SnippetBlock key={i} snippet={snippet} token={activeToken} revealed={revealed} />
          ))}
        </div>

        {active.oauth && (
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Or sign in from the client
            </h3>
            {/* The durable path. Worth preferring, and worth saying why rather
                than leaving the reader to compare two commands. */}
            <p className="-mt-1 text-sm text-muted-foreground">
              The client runs the sign-in itself and refreshes its own token, so nothing expires in an
              hour and no credential is pasted anywhere.
            </p>
            {active.oauth.map((snippet, i) => (
              <SnippetBlock key={i} snippet={snippet} token={null} revealed />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SnippetBlock({
  snippet,
  token,
  revealed,
}: {
  snippet: Snippet
  token: string | null
  revealed: boolean
}) {
  // Copy always carries the real value; only the display is masked. A command
  // you can read but not use would be worse than useless.
  const shown = revealed ? snippet.text : maskSnippet(snippet.text, token)

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">{snippet.heading}</p>
      {snippet.caption && <p className="-mt-1 text-sm text-muted-foreground">{snippet.caption}</p>}
      <div className="relative">
        <span className="absolute right-3 top-2 z-10">
          <CopyButton value={snippet.text} />
        </span>
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 pr-10 font-mono text-xs text-foreground">
          {shown}
        </pre>
      </div>
    </div>
  )
}
