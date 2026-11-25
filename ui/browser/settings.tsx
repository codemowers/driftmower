"use client"

import { FileKey2, LoaderCircle } from "lucide-react"
import { createContext, useContext, useEffect, useState } from "react"
import DownloadProgress from "@/app/components/download-progress"
import CopyButton from "@/app/components/copy-button"
import MyAccess from "@/app/users/components/my-access"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useKubeconfigState } from "@/lib/kubernetes/context-state"
import type { InstallOptions } from "@/lib/kubernetes/contexts"
import { InstallDriftmower } from "./install-driftmower"
import { deploymentConfig, subscribeDesktopConfig, ensureChromeProfile, installDriftmower, kubernetesSignIn, loginToEndpoint, saveChromeProfile, contextTitle, useConnectionProgress, type DashboardConfig } from "./connection"

// A context's state: green when its MCP is available, yellow when the API
// server answers but credentials need a sign-in or refresh, red when the
// API server cannot be reached.
const STATE_DOT = { available: "bg-status-ok", auth: "bg-status-patch", unreachable: "bg-status-major", other: "bg-gray-300" } as const
const STATE_TITLE = { available: "Available", auth: "API server reachable; credentials need a sign-in or refresh", unreachable: "API server unreachable", other: "Reachable; see the status" } as const

const EXTENSION_EXAMPLE = `clusters:
  - name: talos-dev1.codemowers.io
    cluster:
      server: https://172.31.253.250:6443
      # Keep your existing CA fields.
      extensions:
        - name: driftmower.codemowers.io/desktop
          extension:
            sshJumpHost: lauri@192.168.212.10
users:
  - name: admin@talos-dev1.codemowers.io
    user:
      # Keep your existing certificate, token or exec fields.
      extensions:
        - name: driftmower.codemowers.io/desktop
          extension:
            chromeProfile:
              directory: "Profile 1"
              name: Work`

export const SettingsContext = createContext<{streamUpdates: boolean; setStreamUpdates: (enabled: boolean) => void}>({ streamUpdates: true, setStreamUpdates: () => {} })

export default function SettingsPage() {
 const {streamUpdates,setStreamUpdates}=useContext(SettingsContext)
 const [config,setConfig]=useState<DashboardConfig|null>(null)
 const [error,setError]=useState("")
 const [notice,setNotice]=useState("")
 const [savingProfile,setSavingProfile]=useState<string|null>(null)
 const connectingTo=useConnectionProgress(state=>state.target)
 const connecting=Boolean(connectingTo)
 const connected=useClusterState(state=>state.isConnected)
 const kubeconfig=useKubeconfigState()
 const [connectingKey,setConnectingKey]=useState<string|null>(null)
 const [signingIn,setSigningIn]=useState<string|null>(null)
 async function signIn(context:string){setError("");setSigningIn(context);try{const selected=config?.contexts?.find(c=>c.name===context);if(selected&&!(await ensureChromeProfile(selected.key)))return;await kubernetesSignIn(context);setConfig(await deploymentConfig(true))}catch(e){setError((e as Error).message)}finally{setSigningIn(null)}}
 async function connect(url:string,contextKey?:string){setError("");setNotice("");setConnectingKey(contextKey??"configured");try{const profile=await loginToEndpoint(url,contextKey);setConfig(await deploymentConfig(true));if(profile)setNotice(`Opened in Chrome profile ${profile}`)}catch(e){setError((e as Error).message)}finally{setConnectingKey(null)}}
 async function install(key:string,options:InstallOptions){setError("");setNotice("");try{setConfig(await installDriftmower(key,options));setNotice("Driftmower installed; checking the connection")}catch(e){setError((e as Error).message);throw e}}
 async function setProfile(key:string,directory:string){setError("");setNotice("");setSavingProfile(key);try{setConfig(await saveChromeProfile(key,directory))}catch(e){setError((e as Error).message)}finally{setSavingProfile(null)}}
 useEffect(()=>subscribeDesktopConfig(setConfig,error=>setError(error.message)),[])
 return <div className="mx-auto max-w-4xl space-y-8 p-6">
  <h1 className="text-2xl font-semibold">Settings</h1>
  <p className="text-sm text-muted-foreground">Connect to a context to open the dashboard views.</p>
  {error&&<p role="alert" className="text-red-700">{error}</p>}
  {notice&&<p role="status" className="text-sm text-muted-foreground">{notice}</p>}
  {config?.chromeProfilesError&&<p role="alert" className="text-red-700">{config.chromeProfilesError}</p>}
  {config?.mcpUrl&&<section className="flex items-center justify-between gap-4 rounded border p-3"><div><h2 className="font-medium">Configured context</h2><p className="break-all font-mono text-sm">{contextTitle(config.mcpUrl)}</p></div><button disabled={connecting} className="rounded border px-3 py-1 text-sm disabled:opacity-50" onClick={()=>void connect(config.mcpUrl!)}>{connectingTo===config.mcpUrl?<span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden/>Connecting…<DownloadProgress /></span>:"Connect"}</button></section>}
  <section className="space-y-3"><h2 className="text-lg font-medium">Updates</h2>
   <label className="flex items-start gap-3"><input type="checkbox" checked={streamUpdates} onChange={e=>setStreamUpdates(e.target.checked)}/><span>Stream updates<span className="block text-sm text-muted-foreground">Refresh from MCP notifications, with polling fallback.</span></span></label>
  </section>
  {/* In-cluster the dashboard has one configured context and nothing to discover. */}
  {!(config?.mcpUrl&&!config.discoveryEnabled)&&<section className="space-y-3"><h2 className="text-lg font-medium">Discovered contexts</h2>
   {!config?<p>Loading contexts…</p>:!config.discoveryEnabled?<p className="text-sm text-muted-foreground">Kubeconfig discovery is disabled. Enable it when starting the local dashboard.</p>:<>
    <p className="text-sm text-muted-foreground">When MCP has no Ingress, the desktop opens a local port-forward using this connection’s Kubernetes credentials.</p>
    <p className="text-xs text-muted-foreground">One connection per API server and authentication identity. Namespace-specific kubeconfig names are retained for kubectl commands.</p>
    <div className="divide-y rounded border">{config.contexts?.map(c => <div key={c.key || c.name} className="flex flex-wrap items-center justify-between gap-4 p-3">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span title={STATE_TITLE[c.state ?? "other"]} className={`mt-1.5 size-2 shrink-0 rounded-full ${STATE_DOT[c.state ?? "other"]}`} />
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-2 break-all font-mono text-sm">{c.name}{c.certificate && <FileKey2 className="size-4 shrink-0 text-brand-icon" aria-label="Kubernetes client certificate" />} {connected && kubeconfig.selectedKey === c.key && <span className="font-sans text-xs text-muted-foreground">Connected</span>}</p>
          <p className="break-all text-xs text-muted-foreground">{c.apiServer}{c.authMethod && ` · ${c.authMethod}`}</p>
          {(c.status!=="available"||c.portForward)&&<p className={`break-all text-sm ${c.state === "auth" ? "text-status-patch-label" : c.state === "unreachable" ? "text-status-major-label" : "text-muted-foreground"}`}>{c.status!=="available"?c.status:null}{c.portForward && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">Port-forward</span>}</p>}
          {c.aliases && c.aliases.length > 1 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{c.aliases.length} kubeconfig names</summary><ul className="mt-1 space-y-1">{c.aliases.map(alias => <li key={alias.name} className="break-all font-mono">{alias.name}<span className="font-sans"> · {alias.namespace ? `namespace ${alias.namespace}` : "no namespace set"}</span></li>)}</ul></details>}
          {c.install && <InstallDriftmower connection={c} busy={connecting||signingIn!==null} onInstall={(key,options)=>install(key,options).catch(()=>{})}/>}
          {c.signIn && c.signInCommand && <p className="break-all font-mono text-xs text-muted-foreground">Sign in runs {c.signInCommand}</p>}
          {config.chromeProfilesEnabled&&c.chromeProfile&&<div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Chrome profile: {c.chromeProfile.name}</span><button type="button" className="rounded border px-2 py-1 text-xs" disabled={savingProfile!==null||signingIn!==null||connecting} onClick={()=>void setProfile(c.key,"")}>Clear association</button>{savingProfile===c.key&&<LoaderCircle className="size-4 animate-spin" aria-label="Clearing Chrome profile"/>}</div>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {c.signIn && <button className="rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40" disabled={signingIn !== null} title={c.signInCommand || "Runs kubelogin; finish signing in in your browser"} onClick={() => void signIn(c.name)}>{signingIn === c.name ? <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden />Waiting for browser…</span> : "Sign in"}</button>}
        <button className="rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40" disabled={connecting||connectingKey!==null} onClick={() => void connect(c.url ?? "", c.key)}>{connectingKey===c.key || (connectingTo === c.url && !!c.url) ? <span className="inline-flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden />Connecting…<DownloadProgress /></span> : "Connect"}</button>
      </div>
    </div>)}{config.contexts?.length === 0 && <p className="p-3 text-sm">No kubeconfig contexts found.</p>}</div>
   </>}
  </section>}
  {connected&&<MyAccess/>}
  {config?.chromeProfilesEnabled&&<section className="space-y-4 border-t pt-6" aria-labelledby="desktop-extensions-title">
   <div className="flex items-center justify-between gap-3"><h2 id="desktop-extensions-title" className="text-base font-semibold">Driftmower kubeconfig extensions</h2><CopyButton value={EXTENSION_EXAMPLE}/></div>
   <p className="text-sm text-muted-foreground">Configure desktop behavior in your kubeconfig, normally <code>~/.kube/config</code> or the files listed in <code>KUBECONFIG</code>. Merge these extensions into existing entries; retain their credentials, CA fields and other extensions. This example is a fragment, not a replacement kubeconfig.</p>
   <pre className="overflow-x-auto rounded-lg border bg-muted p-4 text-xs"><code>{EXTENSION_EXAMPLE}</code></pre>
   <dl className="space-y-3 text-sm">
    <div><dt className="font-medium">SSH jump host — cluster extension</dt><dd className="mt-1 text-muted-foreground"><code>sshJumpHost</code> accepts an SSH host alias from <code>~/.ssh/config</code> or <code>user@host</code>. ProxyJump and existing SSH settings apply. The desktop reuses an existing SSH master when available and closes only its own forward. Keep a YubiKey-authenticated SSH connection open to avoid repeated authentication; a fresh connection may require a touch. The Kubernetes API retains its certificate validation. Configure either this jump host or <code>proxy-url</code>, not both.</dd></div>
    <div><dt className="font-medium">Chrome profile — user/auth extension</dt><dd className="mt-1 text-muted-foreground"><code>chromeProfile</code> assigns one existing Chrome profile to this kubeconfig user/auth entry, shared by every context using it. The directory is Chrome’s folder name, such as <code>Default</code> or <code>Profile 1</code>, rather than its display name. Connect or Sign in prompts for a profile when needed and writes this association for you. Clear association above to choose again. Namespace aliases and different API servers using the same auth entry share this profile. Different auth entries can use different profiles.</dd></div>
    <div><dt className="font-medium">Desktop-only behavior</dt><dd className="mt-1 text-muted-foreground">Kubectl preserves these extension fields but does not open SSH tunnels or select Chrome profiles. Driftmower uses the jump host for both API discovery and MCP port-forwarding. A local forward does not replace the cluster’s real API URL in kubeconfig.</dd></div>
   </dl>
  </section>}
 </div>
}
