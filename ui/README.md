# Driftmower UI

The web frontend of Driftmower, Codemowers' Kubernetes drift and health monitor. It runs inside the cluster it
watches: it reads the Kubernetes API with its own ServiceAccount, signs users in through passmower and gets its
reports from driftmower-be.

## Deploy

The manifests are in [k8s/](k8s/) and [skaffold](https://skaffold.dev) deploys them. Which cluster, namespace and
registry to use lives in your own config, not in the repo. Run everything from the repository root, one level
above this directory: the `ui` Skaffold module builds and deploys only this app.

### Before you start

The cluster needs:

- **passmower 2.1.1 or newer.** It registers this app as an OIDC client and signs users in. 2.1.0 rejects the
`applications` and `namespaces` scopes the app asks for.
- **driftmower-be** in the same namespace, with `OIDC_AUDIENCE=https://driftmower-api`.
- **cert-manager** with a ClusterIssuer named `letsencrypt`, and the **traefik** ingress class. If yours are named
differently, edit [k8s/certificate.yaml](k8s/certificate.yaml) and [k8s/ingress.yaml](k8s/ingress.yaml).
- A container registry the cluster can pull from.

### 1. Choose the cluster, namespace and registry

```bash
cp skaffold.env.example skaffold.env
skaffold config set default-repo zot.registry.ee-lte-1.codemowers.io/<your user> --kube-context ee-lte-1.codemowers.io
```

`skaffold.env` tells skaffold which kubeconfig context and namespace to deploy to. The example names the
`driftmower` namespace; these manifests expect `driftmowers` unless you change them as in step 2. The second command saves the registry the image is pushed to for that context, in
`~/.skaffold/config`. Both stay on your machine.

### 2. Point the manifests at your host

```bash
export HOST=driftmower.example.com
sed -i "s#driftmower.ee#$HOST#g" ui/k8s/deployment.yaml ui/k8s/oidcclient.yaml ui/k8s/ingress.yaml ui/k8s/certificate.yaml
```

Outside the `driftmowers` namespace, also fix the two ClusterRoleBinding subjects, which skaffold cannot set:

```bash
sed -i "s#namespace: driftmowers#namespace: <your namespace>#" ui/k8s/rbac.yaml
```

If your registry is public, delete the two `imagePullSecrets` lines from [k8s/deployment.yaml](k8s/deployment.yaml).

### 3. Create the namespace and secrets

```bash
export NS=driftmowers
kubectl create namespace "$NS"
kubectl -n "$NS" create secret generic driftmower-ui-session --from-literal=SESSION_SECRET=$(openssl rand -hex 32)
kubectl -n "$NS" create secret docker-registry driftmower-ui-registry \
  --docker-server=zot.registry.ee-lte-1.codemowers.io --docker-username=<user> --docker-password=<token>
```

The last one is the pull secret for a private registry. passmower creates one more Secret,
`oidc-client-driftmower-ui-owner-secrets`, by itself once the OIDCClient is applied in step 4. The Secrets for
optional features are created under [Optional features](#optional-features).

### 4. Deploy

```bash
skaffold run -m ui
```

This builds the image, pushes it to your registry and applies the manifests into your namespace.

### 5. Check it is up

Wait until passmower has written the OIDC Secret. Until then the pod sits in `CreateContainerConfigError`, and it
starts by itself once the Secret appears:

```bash
kubectl -n "$NS" get secret oidc-client-driftmower-ui-owner-secrets
kubectl -n "$NS" rollout status deployment/driftmower-ui
```

Then open `https://$HOST` and sign in.

### Required settings

[k8s/deployment.yaml](k8s/deployment.yaml) already sets everything the app needs to run, and steps 2 to 4 fill in
the values. What each one does is under [Required](#required) below. [`.env.example`](.env.example) lists the same
variables with comments, for local `npm run dev`; the cluster reads them from the Deployment only.


| Variable                                               | Value                        | Where it comes from                                                                 |
| ------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------- |
| `APP_BASE_URL`                                         | `https://$HOST`              | Step 2 writes it into the manifest                                                  |
| `OIDC_AUDIENCE`                                        | `https://driftmower-api`     | Already in the manifest. Must equal driftmower-be's `OIDC_AUDIENCE`                 |
| `SESSION_SECRET`                                       | 32 or more random characters | The `driftmower-ui-session` Secret from step 3                                      |
| `OIDC_IDP_URI`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Written by passmower         | The `oidc-client-driftmower-ui-owner-secrets` Secret passmower creates after step 4 |


### Optional features

Each of these adds one feature, and leaving it out costs only that feature. Set them all for the full product.
Environment variables go in the `env:` list of [k8s/deployment.yaml](k8s/deployment.yaml), and running step 4
again applies a change. What you lose without each one is under [Optional integrations](#optional-integrations)
below.

#### Pod diagnosis and action verdicts (optional)

Any OpenAI-compatible endpoint, including a llama.cpp server in the cluster. The manifest points at Codemowers'
endpoint, so replace the URL with your endpoint's base URL ending in `/v1`, reachable from the pod. The key is sent
as a bearer token; the manifest already reads this Secret and starts without it.

```bash
kubectl -n "$NS" create secret generic llama-api-token --from-literal=token=<LLM API key>
```

```yaml
- name: LLM_BASE_URL
  value: "http://<llama-server>.<namespace>.svc:8080/v1"
- name: OPENAI_API_KEY
  valueFrom:
    secretKeyRef:
      name: llama-api-token
      key: token
```

For OpenAI itself, also set the provider and a model id, since OpenAI has no default model:

```yaml
- name: LLM_BASE_URL
  value: "https://api.openai.com/v1"
- name: LLM_PROVIDER
  value: "openai"
- name: LLM_MODEL
  value: "<model id>"
```

#### Release notes in the Actions card (optional)

The manifest already reads this Secret and starts without it. A GitHub token with no scopes is enough.

```bash
kubectl -n "$NS" create secret generic github-token --from-literal=token=<GitHub token>
```

#### Argo CD links (optional)

The manifest points at Codemowers' Argo CD, so replace the URL with the address you open Argo CD's web UI at,
without a path.

```yaml
- name: ARGO_URL
  value: "https://argocd.example.com"
```

#### Sandboxes page and sandbox scoping (optional)

Needs platform-manager serving `/api/sandboxes`. The value is its in-cluster Service URL. Leave it unset if
platform-manager is not deployed. If platform-manager verifies a different OIDC audience than
`https://platform-manager-api`, also set `PLATFORM_MANAGER_AUDIENCE` to that audience.

```yaml
- name: PLATFORM_MANAGER_URL
  value: "http://platform-manager.platform-manager.svc"
```

#### Provisioning page (optional)

Needs driftmower-mcp. The manifest already carries these with `MCP_ENABLED` off. Turn it on only after checking it
on a test deployment: it adds a third resource indicator to every login, and a passmower that rejects it breaks
login for every user. Setting it back to `false` rolls it back.

- `DRIFTMOWER_MCP_URL`: driftmower-mcp's Service URL. Add `.<namespace>.svc` when it runs in another namespace.
- `MCP_AUDIENCE`: must equal the `MCP_AUDIENCE` driftmower-mcp itself verifies.
- `MCP_PUBLIC_URL`: driftmower-mcp's public Ingress URL, shown in the connection recipes.
- `MCP_OIDC_CLIENT_ID`: nothing to set. The manifest reads it from the Secret driftmower-mcp's OIDCClient creates.

```yaml
- name: DRIFTMOWER_MCP_URL
  value: "http://driftmower-mcp:3000"
- name: MCP_AUDIENCE
  value: "https://driftmower-mcp"
- name: MCP_ENABLED
  value: "true"
- name: MCP_PUBLIC_URL
  value: "https://driftmower-mcp.example.com"
```

#### Restart button on workloads (optional)

The RBAC it needs is already in [k8s/rbac.yaml](k8s/rbac.yaml).

```yaml
- name: WORKLOAD_RESTART_ENABLED
  value: "true"
```

#### Network topology (optional)

Install [netstatd](https://github.com/codemowers/netstatd) in any namespace. No setting is needed, but its pods must
be reachable from this app's namespace.

#### Cluster metrics and pod logs (optional)

Install kube-prometheus-stack and Loki in the `monitoring` namespace. No setting is needed. If `monitoring` denies
ingress by default, let this app in, adjusting the pod labels to your Prometheus and Loki:

```bash
kubectl apply -f - <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: prometheus-allow-driftmower-ui
  namespace: monitoring
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: prometheus
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: $NS
          podSelector:
            matchLabels:
              app: driftmower-ui
      ports:
        - port: 9090
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: loki-allow-driftmower-ui
  namespace: monitoring
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: loki
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: $NS
          podSelector:
            matchLabels:
              app: driftmower-ui
      ports:
        - port: 3100
YAML
```

## Design docs

- `[provisioning.md](provisioning.md)` — self-service provisioning: the design of
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


| Variable             | Purpose                                                        | Where the value comes from                                                                                                                         |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`     | Encrypts the session cookie. Must be at least 32 chars         | You generate it: `openssl rand -hex 32`, kept in a Secret                                                                                          |
| `APP_BASE_URL`       | Public URL of this app; the OIDC redirect URI is built from it | Your ingress host, e.g. `https://driftmower.ee`. Must match a `redirectUris` entry in the OIDCClient, which is `${APP_BASE_URL}/api/auth/callback` |
| `OIDC_AUDIENCE`      | Resource indicator requested from passmower                    | Conventionally `https://driftmower-api`. Must equal driftmower-be's `OIDC_AUDIENCE`, or the backend rejects the access token                       |
| `OIDC_IDP_URI`       | passmower issuer URL                                           | passmower-generated `oidc-client-driftmower-ui-owner-secrets` Secret                                                                               |
| `OIDC_CLIENT_ID`     | OIDC client id                                                 | The same Secret                                                                                                                                    |
| `OIDC_CLIENT_SECRET` | OIDC client secret                                             | The same Secret                                                                                                                                    |


### Optional integrations

What you gain by setting each one, and exactly what you miss by leaving it out.


| Feature                                | Set                                                                                                | Without it                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Provisioning page**                  | `DRIFTMOWER_MCP_URL`, `MCP_ENABLED=true` and a matching `MCP_AUDIENCE`                             | The page's facts come from driftmower-mcp, read as the signed-in user with an MCP-audience token minted from the session. Without these the page explains which one is missing instead of showing cluster facts. `MCP_PUBLIC_URL` (the gateway's public URL) fills in the connection recipes, and `MCP_OIDC_CLIENT_ID` (the public `driftmower-mcp` OIDCClient) adds the OAuth flow to them; without either, that part of the recipes is left out                        |
| **Sandboxes page and sandbox scoping** | `PLATFORM_MANAGER_URL`                                                                             | The Sandboxes page shows a "not configured" state and the sidebar sandbox picker stays hidden. Pointing it at an unreachable host produces a 502 instead, so leave it unset unless platform-manager is actually deployed. Requires a platform-manager serving `/api/sandboxes`; the older `/api/tenants` was renamed upstream                                                                                                                                            |
| **Pod diagnosis and action verdicts**  | `LLM_BASE_URL`, plus `OPENAI_API_KEY` when the endpoint needs one (any OpenAI-compatible endpoint) | The Diagnosis card on failing pods shows only the cause, age and spread it reads from the cluster, and the Actions card shows its rows with verdicts from version distance and the CVE scan only. Their routes (`/api/llm/pod-diagnosis`, `/api/llm/actions/assess`) answer 503. There is deliberately no default endpoint, so an unconfigured deployment never calls someone else's host. The AI insights card is separate: it comes from the backend's report          |
| **Release notes in the Actions card**  | `GITHUB_TOKEN` (a token with no scopes is enough)                                                  | Changelogs for images are fetched from the GitHub Releases API anonymously, which allows 60 requests per hour per egress IP; a busy cluster hits that and the affected rows fall back to a verdict from version distance and the CVE scan only                                                                                                                                                                                                                           |
| **Argo CD deep links**                 | `ARGO_URL`                                                                                         | Argo-managed resources are still detected and labelled, they just aren't clickable through to Argo                                                                                                                                                                                                                                                                                                                                                                       |
| **Restart button on workloads**        | `WORKLOAD_RESTART_ENABLED=true`                                                                    | Off by default. When on, the workload page of a Deployment or StatefulSet that no other object owns gets a Restart tile, which does the same as `kubectl rollout restart` (Argo-managed workloads have their pods deleted instead, so Argo does not report drift). The service account needs `patch` on `deployments` and `statefulsets`; the live-patch ClusterRole already grants it. Without it the tile is hidden and the restart route answers 503                  |
| **Network topology**                   | nothing                                                                                            | Works with no configuration: the server finds the netstatd DaemonSet pods through the Kubernetes API (label `app=netstatd`), merges their streams itself and serves the result over an authenticated SSE endpoint scoped to the viewer's sandboxes. The browser never talks to netstatd. If no netstatd pods are found, the Network card turns grey and stops linking, the topology pages say netstatd was not found, and the Ports tab leaves out its Listening section |
| **Cluster metrics and node storage**   | nothing                                                                                            | In-cluster the target is hardwired to `prometheus-operated.monitoring:9090`. Without kube-prometheus-stack the cards are simply hidden. This is not repointable in-cluster today                                                                                                                                                                                                                                                                                         |
| **Pod logs**                           | nothing                                                                                            | In-cluster Loki is hardwired to `loki.monitoring:3100`. When it is unreachable or empty the Logs tab falls back to the Kubernetes API `pods/log` subresource, so logs work either way                                                                                                                                                                                                                                                                                    |


### Rarely set


| Variable                        | Default                                                        | Set it when                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_URL`                   | `http://driftmower-be:3030`                                    | The default is a bare Service name, which the pod's DNS search path resolves **in the UI pod's own namespace**. Only needed when the backend sits in a different namespace (`http://driftmower-be.<namespace>.svc:3030`), when its Service is renamed, or in local dev. Getting it wrong shows up as 502s plus `[be-proxy] ... ENOTFOUND` in the pod log |
| `OIDC_SCOPE`                    | `openid profile groups applications namespaces offline_access` | Your passmower does not offer one of these scopes. `applications` backs the OIDC Applications page, `namespaces` carries the tenancy claim that driftmower-be scopes on                                                                                                                                                                                  |
| `SESSION_COOKIE_NAME`           | `driftmower_session`                                           | Two deployments share a domain and their cookies would collide                                                                                                                                                                                                                                                                                           |
| `PLATFORM_MANAGER_AUDIENCE`     | `https://platform-manager-api`                                 | Your platform-manager uses a different audience (`API_AUDIENCES`)                                                                                                                                                                                                                                                                                        |
| `K8S_DISTRO`                    | auto-detected from node versions                               | Detection gets it wrong. One of `k3s`, `rke2`, `vanilla`                                                                                                                                                                                                                                                                                                 |
| `LLM_PROVIDER`                  | `llama_cpp`                                                    | The LLM endpoint is OpenAI itself: set `openai`, spelled as in driftmower-ai. That drops the llama.cpp-only request fields OpenAI rejects                                                                                                                                                                                                                |
| `LLM_MODEL`                     | the endpoint's own model on llama.cpp                          | You want a specific model id. **Required** with `LLM_PROVIDER=openai`, where the id is account-specific; without it the diagnosis and actions routes answer 503                                                                                                                                                                                          |
| `PROMETHEUS_URL`                | in-cluster: hardwired                                          | **Local dev only.** Ignored in-cluster, where the variable is never read. Outside a cluster the metrics cards stay hidden without it                                                                                                                                                                                                                     |
| `LOKI_URL`                      | in-cluster: hardwired                                          | **Local dev only**, same as above. Loki has no Ingress, so reach it with `kubectl port-forward svc/loki -n monitoring 3100`                                                                                                                                                                                                                              |
| `NETSTATD_LABEL_SELECTOR`       | `app=netstatd`                                                 | netstatd's pods carry a different label. This is the Kubernetes label selector the server uses to find them, and it streams from every pod that matches. Leaving it unset is normal and disables nothing                                                                                                                                                 |
| `ENDOFLIFE_BASE_URL`            | `https://endoflife.date/api/v1/products`                       | Air-gapped cluster or a mirror. Unreachable simply hides the support-schedule info                                                                                                                                                                                                                                                                       |
| `ARTIFACT_HUB_BASE_URL`         | `https://artifacthub.io/api/v1`                                | Air-gapped cluster or a mirror. Unreachable leaves chart actions without release notes                                                                                                                                                                                                                                                                   |
| `K8S_VERSION_STABLE_URL`        | `https://dl.k8s.io/release/stable.txt`                         | Air-gapped cluster or a mirror                                                                                                                                                                                                                                                                                                                           |
| `K8S_VERSION_LATEST_URL`        | `https://dl.k8s.io/release/latest.txt`                         | Air-gapped cluster or a mirror                                                                                                                                                                                                                                                                                                                           |
| `K8S_VERSION_CHANNELS_URL_K3S`  | `https://update.k3s.io/v1-release/channels`                    | Air-gapped cluster or a mirror                                                                                                                                                                                                                                                                                                                           |
| `K8S_VERSION_CHANNELS_URL_RKE2` | `https://update.rke2.io/v1-release/channels`                   | Air-gapped cluster or a mirror                                                                                                                                                                                                                                                                                                                           |


### Set for you

`NODE_ENV`, `PORT` (8080) and `HOSTNAME` (`::`) are baked into the image. The container runs as a non-root user, so the Service's `targetPort` must be 8080. `KUBERNETES_SERVICE_HOST` and
`KUBERNETES_SERVICE_PORT` are injected by the kubelet and are how the app knows it is running inside a
cluster. Do not set any of them yourself.