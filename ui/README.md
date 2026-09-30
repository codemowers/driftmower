This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Design docs

- [`provisioning.md`](provisioning.md) — self-service provisioning: the design of
  the capability layer (now served by driftmower-mcp, which this app relays), the MCP server and the UI views, plus the
  phase sequencing. Phases 1–2 are implemented.

## Environment variables

Everything is read at runtime by the Next.js server (no `NEXT_PUBLIC_` build-time values), so one image
works in any cluster. [`.env.example`](.env.example) is the same list in copy-to-`.env.local` form.

Three tiers: **required** (the app is unusable without them), **optional integrations** (each unlocks one
feature, and skipping it costs you only that feature), and **rarely set** (working defaults that only
unusual clusters need to override).

Note for local development: OIDC login cannot work on `localhost`, because the redirect URI is registered
per cluster and passmower runs in-cluster. Anything behind a session has to be tested on a deployed build.

### Required

Missing any of these throws `Missing required environment variable: <name>` on the first request that
touches auth. The pod still goes Ready, so the symptom is a failing login rather than a crash loop.

| Variable | Purpose | Where the value comes from |
|---|---|---|
| `SESSION_SECRET` | Encrypts the session cookie. Must be at least 32 chars | You generate it: `openssl rand -hex 32`, kept in a Secret |
| `APP_BASE_URL` | Public URL of this app; the OIDC redirect URI is built from it | Your ingress host, e.g. `https://driftmower-ui.ee-lte-1.codemowers.io`. Must match a `redirectUris` entry in the OIDCClient, which is `${APP_BASE_URL}/api/auth/callback` |
| `OIDC_AUDIENCE` | Resource indicator requested from passmower | Conventionally `https://driftmower-api`. Must equal driftmower-be's `OIDC_AUDIENCE`, or the backend rejects the access token |
| `OIDC_IDP_URI` | passmower issuer URL | passmower-generated `oidc-client-driftmower-ui-owner-secrets` Secret |
| `OIDC_CLIENT_ID` | OIDC client id | The same Secret |
| `OIDC_CLIENT_SECRET` | OIDC client secret | The same Secret |

### Optional integrations

What you gain by setting each one, and exactly what you miss by leaving it out.

| Feature | Set | Without it |
|---|---|---|
| **Provisioning page** | `DRIFTMOWER_MCP_URL`, `MCP_ENABLED=true` and a matching `MCP_AUDIENCE` | The page's facts come from driftmower-mcp, read as the signed-in user with an MCP-audience token minted from the session. Without these the page explains which one is missing instead of showing cluster facts |
| **Sandboxes page and sandbox scoping** | `PLATFORM_MANAGER_URL` | The Sandboxes page shows a "not configured" state and the sidebar sandbox picker stays hidden. Pointing it at an unreachable host produces a 502 instead, so leave it unset unless platform-manager is actually deployed. Requires a platform-manager serving `/api/sandboxes`; the older `/api/tenants` was renamed upstream |
| **AI workload and pod summaries** | `LLM_BASE_URL` and `OPENAI_API_KEY` (any OpenAI-compatible endpoint) | The summary panels are unavailable and `/api/llm` answers 503. There is deliberately no default endpoint, so an unconfigured deployment never calls someone else's host |
| **Release notes in the Actions card** | `GITHUB_TOKEN` (a token with no scopes is enough) | Changelogs for images are fetched from the GitHub Releases API anonymously, which allows 60 requests per hour per egress IP; a busy cluster hits that and the affected rows fall back to a verdict from version distance and the CVE scan only |
| **Argo CD deep links** | `ARGO_URL` | Argo-managed resources are still detected and labelled, they just aren't clickable through to Argo |
| **Network topology** | nothing | Works with no configuration: the server finds the netstatd DaemonSet pods through the Kubernetes API (label `app=netstatd`), merges their streams itself and serves the result over an authenticated SSE endpoint scoped to the viewer's sandboxes. The browser never talks to netstatd. If netstatd isn't installed, the Topology tab renders an empty state |
| **Cluster metrics and node storage** | nothing | In-cluster the target is hardwired to `prometheus-operated.monitoring:9090`. Without kube-prometheus-stack the cards are simply hidden. This is not repointable in-cluster today |
| **Pod logs** | nothing | In-cluster Loki is hardwired to `loki.monitoring:3100`. When it is unreachable or empty the Logs tab falls back to the Kubernetes API `pods/log` subresource, so logs work either way |

### Rarely set

| Variable | Default | Set it when |
|---|---|---|
| `BACKEND_URL` | `http://driftmower-be:3030` | The default is a bare Service name, which the pod's DNS search path resolves **in the UI pod's own namespace**. Only needed when the backend sits in a different namespace (`http://driftmower-be.<namespace>.svc:3030`), when its Service is renamed, or in local dev. Getting it wrong shows up as 502s plus `[be-proxy] ... ENOTFOUND` in the pod log |
| `OIDC_SCOPE` | `openid profile groups applications namespaces offline_access` | Your passmower does not offer one of these scopes. `applications` backs the OIDC Applications page, `namespaces` carries the tenancy claim that driftmower-be scopes on |
| `SESSION_COOKIE_NAME` | `driftmower_session` | Two deployments share a domain and their cookies would collide |
| `PLATFORM_MANAGER_AUDIENCE` | `https://platform-manager-api` | Your platform-manager uses a different audience (`API_AUDIENCES`) |
| `K8S_DISTRO` | auto-detected from node versions | Detection gets it wrong. One of `k3s`, `rke2`, `vanilla` |
| `PROMETHEUS_URL` | in-cluster: hardwired | **Local dev only.** Ignored in-cluster, where the variable is never read. Outside a cluster the metrics cards stay hidden without it |
| `LOKI_URL` | in-cluster: hardwired | **Local dev only**, same as above. Loki has no Ingress, so reach it with `kubectl port-forward svc/loki -n monitoring 3100` |
| `NETSTATD_LABEL_SELECTOR` | `app=netstatd` | netstatd's pods carry a different label. This is the Kubernetes label selector the server uses to find them, and it streams from every pod that matches. Leaving it unset is normal and disables nothing |
| `ENDOFLIFE_BASE_URL` | `https://endoflife.date/api/v1/products` | Air-gapped cluster or a mirror. Unreachable simply hides the support-schedule info |
| `ARTIFACT_HUB_BASE_URL` | `https://artifacthub.io/api/v1` | Air-gapped cluster or a mirror. Unreachable leaves chart actions without release notes |
| `K8S_VERSION_STABLE_URL` | `https://dl.k8s.io/release/stable.txt` | Air-gapped cluster or a mirror |
| `K8S_VERSION_LATEST_URL` | `https://dl.k8s.io/release/latest.txt` | Air-gapped cluster or a mirror |
| `K8S_VERSION_CHANNELS_URL_K3S` | `https://update.k3s.io/v1-release/channels` | Air-gapped cluster or a mirror |
| `K8S_VERSION_CHANNELS_URL_RKE2` | `https://update.rke2.io/v1-release/channels` | Air-gapped cluster or a mirror |

### Set for you

`NODE_ENV`, `PORT` (80) and `HOSTNAME` (`::`) are baked into the image. `KUBERNETES_SERVICE_HOST` and
`KUBERNETES_SERVICE_PORT` are injected by the kubelet and are how the app knows it is running inside a
cluster. Do not set any of them yourself.
