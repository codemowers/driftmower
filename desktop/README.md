# Driftmower desktop

Download the executable for your operating system and CPU from
[GitHub Releases](https://github.com/codemowers/driftmower/releases). The HTML,
JavaScript and CSS are embedded; install Chrome, Chromium or Firefox and
configure your kubeconfig, then run the executable.

| System | Release asset |
| --- | --- |
| Linux x86-64 | `driftmower-desktop-linux-amd64` |
| Linux ARM64 | `driftmower-desktop-linux-arm64` |
| Mac with Intel CPU | `driftmower-desktop-darwin-amd64` |
| Mac with Apple Silicon | `driftmower-desktop-darwin-arm64` |

For example, on an Apple Silicon Mac, after downloading the executable:

```sh
chmod +x driftmower-desktop-darwin-arm64
./driftmower-desktop-darwin-arm64
```

The application opens your browser at `http://localhost:17843`. In Settings,
choose the kubeconfig connection and sign in when required. Existing browser
profiles and kubeconfig authentication tools are supported on macOS too.
Mac builds are not Developer ID signed or notarized. If macOS blocks a download,
follow [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/102445).
Linux taskbar integration is installed automatically; macOS currently launches
from the executable rather than a Finder application bundle.

## Build from source

From the repository root, build the browser assets and native application
(after `npm --prefix ui ci` and initializing the SPDX submodule):

```sh
desktop/build.sh
desktop/build/driftmower-desktop
```

See the [desktop guide](../docs/desktop.md) for connecting to a cluster.

On Linux, the desktop binary installs a **Driftmower** application launcher
and its icon under `$XDG_DATA_HOME` (normally `~/.local/share`). Chrome app
windows get matching profile-specific desktop entries, so Ubuntu's Wayland
taskbar can show the Driftmower icon separately from ordinary Chrome windows.
Firefox has no application windows, so with Firefox only the launcher is
installed and dashboard windows appear as Firefox windows.
Run `desktop/build/driftmower-desktop --install-desktop` to install/update the entries
without opening a window. Reopen an existing window after installation; use
**Pin to Dash** on its icon to keep it in the taskbar. Launchers refer to this
binary's absolute path, so rerun installation if you move the binary.
The existing browser profiles and their credentials are preserved.

`desktop/` runs the same dashboard on `localhost:17843` and opens it in a
browser: `--browser=chrome|chromium|firefox` (or `DRIFTMOWER_BROWSER`) selects
one; otherwise the system default browser is used when it is Chrome, Chromium
or Firefox (read from `xdg-settings` on Linux, LaunchServices on macOS and the
https handler on Windows), else whichever is installed, Chrome first. Chrome
and Chromium open an application window; Firefox opens an ordinary window. It
uses the person's own browser profile, so passkeys and the password manager
work for MCP sign-in, and it exits a few minutes after the last dashboard window disconnects. The built executable embeds the HTML, JavaScript, CSS and icon; no separate
`public/` directory is needed. `ASSET_DIR` can override the embedded UI during
development.

Settings offers one **browser profile** per kubeconfig user/auth entry.
It reads profile names from Chrome's `Local State` or Firefox's `profiles.ini`
(and `installs.ini` for the default profile), without reading cookies or
passwords. **Connect** opens a dashboard window in the assigned profile, so MCP
OIDC login uses that profile's session. Every context using that auth entry shares the setting, even across API servers;
different authentication identities remain separate. Each window keeps its own
selected connection, even when several windows use one browser profile.

The selection is saved on the existing kubeconfig auth entry using the supported
extension field (other auth fields and the current context remain unchanged):

```yaml
users:
  - name: work-user
    user:
      # Existing certificate/token/exec settings remain here.
      extensions:
        - name: driftmower.codemowers.io/desktop
          extension:
            chromeProfile:
              directory: Profile 1
              name: Work
            firefoxProfile:
              directory: Profiles/abc123.work
              name: Work
```

Chrome and Firefox assignments are separate fields, so switching the desktop's
browser keeps the other browser's choice. A Firefox `directory` is the profile's
`Path` from `profiles.ini` (relative to it unless `IsRelative=0`); only profiles
listed there are opened.

The desktop updates the auth stanza's originating file when KUBECONFIG merges
several files. Assigned kubelogin sign-in uses the same browser profile and an
isolated desktop cache, leaving ordinary kubectl's browser/cache behavior alone.
AWS/Azure browser helpers are passed through `BROWSER` where supported; their CLI
credential stores remain provider-managed. `CHROME_USER_DATA_DIR` selects a
nonstandard Chrome user-data directory and `FIREFOX_PROFILES_DIR` a nonstandard
directory containing Firefox's `profiles.ini` (by default the XDG
`~/.config/mozilla/firefox`, `~/.mozilla/firefox` or the Snap copy on Linux). Clear the selector to use the current
profile without a saved assignment.

When MCP has no advertised URL or Ingress, desktop discovery opens a native
Kubernetes port-forward on an OS-assigned `127.0.0.1` port. Settings marks it
**Port-forward**. It uses the same resolved kubeconfig credentials and needs
Pod-list and Pod-port-forward permission; no kubectl process or interactive
credential plugin runs for the tunnel. Namespace aliases share a forward,
while different authentication identities remain separate. A live forward is
reused on discovery refresh; a broken connection or replaced Pod reconnects on
the same local port. Removed contexts and desktop shutdown close their tunnels.
MCP still enforces its configured authentication mode: an anonymous MCP connects
without login; OIDC keeps its canonical resource/audience through the tunnel.

Unlike the container, it may run kubelogin. Discovery still only reads
kubelogin's token cache, so it never opens a browser by itself. A context whose
token is missing or expired gets a **Sign in** button in Settings: the desktop
application then runs that context's own `oidc-login get-token` plugin with its
command, arguments, environment and `KUBERNETES_EXEC_INFO`. Assigned browser
profiles add only the desktop browser and isolated-cache overrides described above.
kubelogin refreshes silently or opens the default browser, and writes its cache;
the token it prints is also kept in memory, which covers keyring storage.
One sign-in per issuer and client runs at a time, for at most five minutes.
`~/.krew/bin`, `~/.local/bin`, `~/go/bin`, `/opt/homebrew/bin` and
`/usr/local/bin` are searched as well, since desktop sessions often start with a
short `PATH`. AWS (`aws eks get-token`) and Azure kubelogin in a mode that
never prompts (`azurecli`, `azd`, `msi`, `workloadidentity`, `spn`) are run by
discovery itself, as kubectl would run them, with their output captured and
each token kept until it expires: they only read the cloud CLI's session. When
that session has expired, Settings shows the context in yellow with the
plugin's own explanation, and **Sign in** runs the login that renews it:
`az login` for the plugin's tenant and the cluster's scope, which also
refreshes multi-factor authentication; `aws login` for a profile with a
`login_session`, or `aws sso login` for an SSO profile. Settings names the
command beside the button. Other credential plugins are never
run: a context also works with a client certificate or token in the
kubeconfig, while other exec providers report "credential plugin unsupported". The
sign-in endpoint accepts only JSON requests from the dashboard's own loopback
origin.

The server binary also discovers contexts with `--discover-kubeconfig` and
optionally `--kubeconfig /path/to/config`, but never runs kubelogin or any other credential plugin. Standard `KUBECONFIG` file lists are supported
when no explicit file is selected. Existing kubeconfig context selection is
never changed.

Open http://localhost:17843/settings. Settings lists every context and its
status, including missing installations, forbidden discovery, and unavailable
credentials. Only contexts where the `mcp` Service (or the previous `driftmower-mcp` name) exists in
`driftmower` and
advertises a public endpoint are offered for connection. Discovery uses the
Service's `driftmower.io/mcp-url` annotation or a matching Ingress; it does not
guess endpoints from Kubernetes API hostnames. Kubeconfig changes use native filesystem
notifications (inotify on Linux and kqueue on macOS), including atomic saves and
changes to any file in `KUBECONFIG`. Settings and navigation receive pushed
updates from the desktop; they do not poll the configuration. Sign-in, Retry and
tunnel lifecycle events also trigger discovery.

The dashboard binds to localhost. Kubernetes credentials remain on its server;
the browser signs into MCP separately with PKCE. Tokens stay in memory; only
endpoint preferences are saved locally.

Each MCP deployment must allow `http://localhost:17843` (and optionally
`http://127.0.0.1:17843`) in `mcp.dashboard.localOrigins`. Its native OIDC client must
allow those CORS origins and `/callback` loopback redirects. The chart configures
both. Local login uses that native public client with PKCE and requests the
selected MCP URL as its resource audience. Cluster-hosted login uses the separate
web client. Arbitrary origins remain rejected.

## Process controls

```sh
desktop/build/driftmower-desktop --status
desktop/build/driftmower-desktop --pid
desktop/build/driftmower-desktop --stop
desktop/build/driftmower-desktop --restart
```

`--status` shows the PID, local address and state-file path. `--pid` prints only
the live PID for scripts. `--stop` shuts down the desktop and its tunnels;
`--restart` stops the current instance and runs this executable. Running the
program without flags reuses an existing instance and opens its Settings window.

The instance record lives at `$XDG_RUNTIME_DIR/driftmower/desktop.json`, or under
your user cache directory when `XDG_RUNTIME_DIR` is unset. Control commands
verify the running instance through its local endpoint rather than sending
signals to a potentially stale PID.
