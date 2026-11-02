# Helm Releases — Data Analysis

## What a "helm release" is here

A helm release is a group of containers that were all deployed by the same Helm chart install.
Each container's `releaseInfo.groupKey` (e.g. `helm/cert-manager/cert-manager`) ties it to a release.

There are **20 helm releases** in the current report, managing **110 containers** total.

---

## Data sources in the report

### 1. `rotenness.releaseScores` — pre-aggregated per-release summary

Keyed by `groupKey`. This is the fast path for the list page — no need to re-group.

```json
"helm/cert-manager/cert-manager": {
  "groupKey": "helm/cert-manager/cert-manager",
  "releaseInfo": {
    "managementKind": "helm",
    "name": "cert-manager",
    "namespace": "cert-manager",
    "chartName": "cert-manager",
    "chartVersion": "v1.20.0",
    "chartAppVersion": "v1.20.0"
  },
  "normalizedScore": 1,         // 0 = healthy, 1 = fully outdated
  "distinctRepoCount": 3,       // how many distinct image repos this release uses
  "staleRepoCount": 3,          // how many of those are outdated
  "totalWorkloadCount": 3,      // number of Deployments/DaemonSets/etc
  "totalContainers": 3          // total containers tracked
}
```

### 2. `report.imageUsages[]` filtered by `releaseInfo.groupKey` — per-container detail

Used for the detail page. Filter `imageUsages` where `u.releaseInfo?.groupKey === targetGroupKey`.

Each container entry has:
```json
{
  "containerName": "cert-manager-controller",
  "image": "quay.io/jetstack/cert-manager-controller:v1.20.0",
  "actualTag": "v1.20.0",
  "imageInfo": {
    "registry": "quay.io",
    "repository": "jetstack/cert-manager-controller",
    "tag": "v1.20.0",
    "digest": "sha256:..."
  },
  "versionStatus": {
    "statusType": "patch_behind",   // up_to_date | patch_behind | minor_behind | major_behind | ahead | no_data | no_version
    "deployedTag": "v1.20.0",
    "latestTag": "v1.20.2",
    "majorDifference": 0,
    "minorDifference": 0,
    "patchDifference": 2
  },
  "workloadRootInfo": {
    "kind": "Deployment",
    "name": "cert-manager",
    "namespace": "cert-manager"
  }
}
```

---

## Current releases snapshot

| Release | Namespace | Chart | Containers | Worst status |
|---|---|---|---|---|
| cert-manager | cert-manager | cert-manager@v1.20.0 | 3 | patch |
| cert-manager-csi-driver | cert-manager | cert-manager-csi-driver@v0.13.0 | 15 | minor |
| trust-manager | cert-manager | trust-manager@v0.22.0 | 2 | patch |
| cnpg | cnpg-system | cloudnative-pg@0.26.0 | 1 | minor |
| dragonfly-operator | dragonfly-operator-system | dragonfly-operator@v1.4.0 | 2 | minor |
| emqx-operator | emqx-operator-system | emqx-operator@2.2.29 | 1 | ok |
| cilium | kube-system | cilium-agent | 39 | minor |
| kubernetes-secret-generator | kube-system | kubernetes-secret-generator@3.4.1 | 1 | ok |
| trivy-operator | kube-system | trivy-operator@0.32.1 | 1 | no_data |
| trivy-ui | kube-system | trivy-ui@0.0.3 | 1 | minor |
| zot | kube-system | zot@0.1.104 | 1 | patch |
| kyverno | kyverno | kyverno@3.7.1 | 5 | no_data |
| policy-reporter | kyverno | policy-reporter@3.7.3 | 3 | minor |
| s3-operator | minio | s3-operator@0.9.0 | 1 | ok |
| mongodb-kubernetes-operator | mongodb | - | 1 | ok |
| node-feature-discovery | node-feature-discovery | node-feature-discovery@0.18.3 | 7 | ok |
| passmower | passmower | passmower-1.2.0@dev | 2 | ok |
| prometheus-operator | prometheus-operator | kube-prometheus-stack | 2 | minor |
| topolvm | topolvm-system | topolvm@15.9.0 | 20 | minor |
| traefik | traefik | traefik@37.4.0 | 2 | no_data |

---

## Page structure proposal

### `/helm-releases` — list page

One row per release, sourced from `rotenness.releaseScores`. Shows:
- Release name + namespace
- Chart name + version
- Worst drift status badge (derived from imageUsages or releaseScores)
- Rottenness score (from `releaseScores[key].normalizedScore`)
- Container count
- Stale / total repos ratio (e.g. `3/3 repos stale`)
- Link to detail page

### `/helm-releases?release=helm%2Fcert-manager%2Fcert-manager` — detail page (query param, same pattern as `?report=`)

Filtered view of `imageUsages` for that release. Shows:
- Chart metadata (name, version, appVersion, namespace)
- Per-container table: container name, workload, registry, deployed tag → latest tag, status badge
- Grouped by workload (Deployment/DaemonSet/StatefulSet)

**Why query param instead of dynamic route (`/helm-releases/[id]`)**:
The `groupKey` contains slashes (`helm/cert-manager/cert-manager`) which are awkward in path segments. A query param (`?release=...`) is simpler and matches the existing `?report=` pattern already in use. URL-encode the groupKey when linking.
