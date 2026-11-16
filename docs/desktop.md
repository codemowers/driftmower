# Desktop dashboard

[Driftmower](../README.md)

Download a matching [desktop release](../desktop/README.md), or build it from
source as shown below.

The desktop application runs the dashboard on `localhost:17843`, opens it in a
Google Chrome (or Chromium) application window and discovers MCP servers from
your kubeconfig:

```bash
desktop/build.sh
desktop/build/driftmower-desktop
```

Settings lists every connection. On first **Sign in** or **Connect**, choose an
existing Chrome profile if several are available; a single profile is selected
automatically. Connect stays in the current window when the profile matches,
and opens a new window in the assigned profile otherwise. **Clear association**
in Settings removes the choice so the next attempt asks again. The name
and directory are saved in the auth entry's `extensions` under
`driftmower.codemowers.io/desktop`; namespace aliases share the choice. The
desktop leaves kubectl authentication settings and the current context intact.

Settings lists your contexts; **Sign in** uses the context's credential provider
when its login is missing or expired, then connect to its MCP. Signing in from
localhost works only against an MCP deployed with
`mcp.dashboard.localOrigins` (Skaffold sets it). A context showing
"MCP installed but not running" has the `mcp` Service but no ready Pod; deploy
it with Skaffold. See [ui/README.md](../ui/README.md) for details.

Without an advertised endpoint or Ingress, the desktop automatically forwards
MCP to an OS-assigned port on `127.0.0.1` and marks the connection **Port-forward**.
Use the context's certificate or an existing login with Pod-list/port-forward
permission. Namespace aliases share a tunnel; different credentials stay
separate. Tunnels reconnect after Pod replacement and close with the desktop.

Settings shows one connection for each Kubernetes API server and authentication
identity, with a certificate icon for client-certificate connections. Different
credentials or impersonation identities stay separate even when they discover
the same MCP endpoint. The desktop retains every kubeconfig namespace alias.
The selected connection supplies the context for rendered commands: a
matching namespace alias produces `kubectl get --context 'foo/bar' …`; otherwise
the command names both `--context 'foo' --namespace 'bar'`. Cluster-scoped
commands name only the context. Without local kubeconfig metadata, replace the
rendered `<context>` placeholder with the intended local context name.

User detail pages include copyable group-removal commands and a selector of
existing local groups discovered from user membership sources. Provider group
removals warn that a later provider login can restore them. The kubectl/jq
commands read the current object and filter or deduplicate the membership array
before applying a merge patch. They also render account
type, sign-in enable/disable, local profile and approval commands; the dashboard
does not execute these snippets. Disabling sign-in does not revoke already
issued tokens. Membership-source metadata excludes provider credentials.

The Volumes list links to PVC/PV detail pages. Their commands target the live
PVC when present, including when opened through a PV link, and fall back to PV
commands after confirmed claim absence. A replaced claim UID is not targeted;
permission failures leave claim existence unknown and suppress PV deletion.
Expansion commands require a Bound PVC, an expandable StorageClass and a larger
absolute capacity. PV-only capacity edits are not offered as storage expansion.
The page shows binding, driver, node/zone affinity and reclaim-policy effects.

## Restart or stop

Use `desktop/build/driftmower-desktop --status` to see its PID and local address,
`--pid` for the PID alone, `--stop` to shut it down, or `--restart` to restart.
The desktop listens on `http://localhost:17843`.
