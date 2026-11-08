package mcpserver

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/codemowers/driftmower/internal/crawler"
	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/findings"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

// dashboardSnapshot is a presentation projection of the authorized Go
// inventory, not a persisted report. Owner resolution is never repeated here.
func addDashboardTool(s *mcp.Server, source FindingsSource, w *Workloads, mapping auth.Mapping, clusterID string) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_dashboard_snapshot", Title: "Read live dashboard snapshot",
		Description: "Current container and root-workload inventory, with crawler release findings. Uses the same caller-authorized ownership graph as get_workloads. No historical database or Trivy Operator dependency. Incomplete coverage is reported in warnings.",
		InputSchema: inputSchema[namespaceInput](nil), Annotations: readOnly("Read live dashboard snapshot"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in namespaceInput) (*mcp.CallToolResult, map[string]any, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		inv, err := w.Cache.List(ctx, in.Namespace, id)
		if err != nil {
			return nil, nil, err
		}
		reports, err := source.Reports(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("crawler findings unavailable: %w", err)
		}
		helm, helmErr := collectHelm(ctx, w, id, in.Namespace, inv.Workloads)
		if helmErr != nil {
			inv.Warnings = append(inv.Warnings, "Helm discovery unavailable.")
		}
		inv.Warnings = append(inv.Warnings, helm.Warnings...)
		releaseByRoot := map[string]*helmRelease{}
		for _, release := range helm.Releases {
			for _, uid := range release.WorkloadUIDs {
				releaseByRoot[uid] = release
			}
		}
		index := findings.NewIndex(reports)
		imageMetadata, metadataWarnings := imageMetadataIndex(ctx, w, id)
		inv.Warnings = append(inv.Warnings, metadataWarnings...)
		owners := map[string]*workloads.Workload{}
		namespaces := map[string]bool{}
		resources := []map[string]any{}
		for _, wl := range inv.Workloads {
			namespaces[wl.Namespace] = true
			if wl.Kind != "Namespace" {
				resources = append(resources, map[string]any{"uid": wl.UID, "kind": wl.Kind, "name": wl.Name, "namespace": wl.Namespace})
			}
			for _, pod := range wl.Pods {
				if wl.Kind != "Namespace" {
					owners[wl.Namespace+"/"+pod] = wl
				}
			}
		}
		nsNames := []string{}
		for ns := range namespaces {
			nsNames = append(nsNames, ns)
		}
		sort.Strings(nsNames)
		usages := []map[string]any{}
		groups := map[string][]map[string]any{}
		scores := map[string]any{}
		releaseGroups := map[string][]map[string]any{}
		for _, ns := range nsNames {
			pods, err := w.Cache.Kubernetes.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
			if err != nil {
				return nil, nil, err
			}
			for _, pod := range pods.Items {
				uid := string(pod.UID)
				wl := owners[ns+"/"+pod.Name]
				if wl == nil {
					wl = &workloads.Workload{UID: uid, Kind: "Pod", Name: pod.Name, Namespace: ns}
				}
				group := wl.Kind + "/" + ns + "/" + wl.Name
				root := map[string]any{"uid": wl.UID, "kind": wl.Kind, "name": wl.Name, "namespace": ns, "groupKey": group}
				resource := map[string]any{"uid": uid, "kind": "Pod", "name": pod.Name, "namespace": ns, "nodeName": pod.Spec.NodeName, "phase": pod.Status.Phase, "createdAt": pod.CreationTimestamp.Format(time.RFC3339), "labels": pod.Labels}
				if wl.UID != uid {
					resource["ownerUID"] = wl.UID
				}
				if pod.Status.PodIP != "" {
					resource["ips"] = []string{pod.Status.PodIP}
				}
				resources = append(resources, resource)
				statuses := map[string]string{}
				for _, status := range pod.Status.ContainerStatuses {
					statuses[status.Name] = status.ImageID
				}
				for _, container := range pod.Spec.Containers {
					image := container.Image
					keys := findings.Keys(image)
					canonical := image
					if len(keys) > 0 {
						canonical = keys[0]
					}
					name, digest, _ := strings.Cut(canonical, "@")
					tag := ""
					tagRef := strings.Split(image, "@")[0]
					if i := strings.LastIndex(tagRef, ":"); i > strings.LastIndex(tagRef, "/") {
						tag = tagRef[i+1:]
					}
					if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
						tag = name[i+1:]
						name = name[:i]
					}
					registry, repo, _ := strings.Cut(name, "/")
					running := strings.TrimPrefix(strings.TrimPrefix(statuses[container.Name], "docker-pullable://"), "containerd://")
					if _, d, ok := strings.Cut(running, "@"); ok {
						digest = d
					} else if strings.HasPrefix(running, "sha256:") {
						digest = running
					}
					match, known := index.Lookup(name + "@" + digest)
					// An immutable running digest must not be replaced by a moving tag's findings.
					if !known && digest == "" {
						match, known = index.Lookup(image)
					}
					vs := map[string]any{"statusType": "no_data", "deployedTag": tag, "latestTag": nil, "majorDifference": 0, "minorDifference": 0, "patchDifference": 0}
					if known {
						vs["deployedTag"] = match.Version.Version
						if match.Source.Latest != nil {
							vs["latestTag"] = match.Source.Latest.Tag
						}
						status := "no_version"
						if match.Version.Behind >= 0 {
							status = "up_to_date"
							if match.Version.Behind > 0 {
								status = "behind"
							}
						}
						deployed, dok := crawler.ParseVersion(match.Version.Version)
						latest, lok := crawler.ParseVersion(latestTag(match.Source))
						if dok && lok && match.Version.Behind > 0 {
							// Compare parsed version components without treating a different tag
							// prefix as a compatible release stream.
							if deployed.Prefix == latest.Prefix {
								a, b := append(append([]int{}, deployed.Core...), 0, 0, 0), append(append([]int{}, latest.Core...), 0, 0, 0)
								vs["majorDifference"], vs["minorDifference"], vs["patchDifference"] = max(0, b[0]-a[0]), max(0, b[1]-a[1]), max(0, b[2]-a[2])
								switch {
								case b[0] > a[0]:
									status = "major_behind"
								case b[1] > a[1]:
									status = "minor_behind"
								default:
									status = "patch_behind"
								}
							}
						}
						if unchecked(match.Source) {
							status = "no_data"
						}
						vs["statusType"] = status
					}
					usage := map[string]any{"context": clusterID, "namespace": ns, "podName": pod.Name, "uid": uid, "containerName": container.Name, "image": image, "originalImage": image, "imageId": running, "controllerKind": wl.Kind, "controllerName": wl.Name, "hasImagePullSecrets": len(pod.Spec.ImagePullSecrets) > 0, "actualTag": tag, "allActualTags": []string{tag}, "tagStatus": "known", "digestSemver": nil,
						"imageInfo": map[string]any{"registry": registry, "repository": repo, "tag": tag, "digest": digest, "sourceStatus": "unknown"}, "versionStatus": vs, "workloadRootInfo": root, "releaseInfo": nil}
					if metadata, ok := imageMetadata[digest]; ok {
						sourceStatus := "unlinked"
						if known || len(metadata.Sources) > 0 {
							sourceStatus = "linked"
						}
						usage["imageInfo"].(map[string]any)["sourceStatus"] = sourceStatus
						usage["imageInfo"].(map[string]any)["labels"] = metadata.Labels
						usage["imageInfo"].(map[string]any)["sourceRepositories"] = metadata.Sources
						usage["imageInfo"].(map[string]any)["containerImage"] = metadata.ContainerImage
						usage["imageInfo"].(map[string]any)["sbomArtifacts"] = metadata.SBOMArtifacts
						usage["imageInfo"].(map[string]any)["scannerNamespace"] = os.Getenv("POD_NAMESPACE")
					}
					if known {
						usage["imageInfo"].(map[string]any)["crawlerSource"] = map[string]string{"url": match.Source.URL, "version": match.Version.Version}
						usage["imageInfo"].(map[string]any)["sourceStatus"] = "linked"
					}
					if release := releaseByRoot[wl.UID]; release != nil {
						usage["releaseInfo"] = release
						releaseGroups[release.GroupKey] = append(releaseGroups[release.GroupKey], usage)
					}
					usages = append(usages, usage)
					groups[group] = append(groups[group], usage)
				}
			}
		}
		weights := map[string]float64{"up_to_date": 0, "ahead": 0, "patch_behind": 1.0 / 3, "minor_behind": 2.0 / 3, "major_behind": 1, "behind": 0.5}
		sum, measured := 0.0, 0
		for key, items := range groups {
			repos := map[string]float64{}
			for _, item := range items {
				vs := item["versionStatus"].(map[string]any)
				weight, ok := weights[vs["statusType"].(string)]
				if !ok {
					continue
				}
				image := item["imageInfo"].(map[string]any)
				repo := image["registry"].(string) + "/" + image["repository"].(string)
				repos[repo] = max(repos[repo], weight)
			}
			total, stale := 0.0, 0
			for _, weight := range repos {
				total += weight
				if weight > 0 {
					stale++
				}
			}
			average := 0.0
			if len(repos) > 0 {
				average = total / float64(len(repos))
				sum += total
				measured += len(repos)
			}
			scores[key] = map[string]any{"groupKey": key, "normalizedScore": average, "distinctRepoCount": len(repos), "staleRepoCount": stale, "totalContainers": len(items), "workloadRootInfo": items[0]["workloadRootInfo"]}
		}
		releaseScores := map[string]any{}
		for _, release := range helm.Releases {
			items := releaseGroups[release.GroupKey]
			repos := map[string]float64{}
			for _, item := range items {
				vs := item["versionStatus"].(map[string]any)
				weight, known := weights[vs["statusType"].(string)]
				if !known {
					continue
				}
				info := item["imageInfo"].(map[string]any)
				key := info["registry"].(string) + "/" + info["repository"].(string)
				repos[key] = max(repos[key], weight)
			}
			total, stale := 0.0, 0
			for _, weight := range repos {
				total += weight
				if weight > 0 {
					stale++
				}
			}
			normalized := 0.0
			if len(repos) > 0 {
				normalized = total / float64(len(repos))
			}
			releaseScores[release.GroupKey] = map[string]any{"groupKey": release.GroupKey, "releaseInfo": release, "normalizedScore": normalized, "distinctRepoCount": len(repos), "staleRepoCount": stale, "totalContainers": len(items), "totalWorkloadCount": len(release.WorkloadUIDs)}
		}
		normalized := 0.0
		if measured > 0 {
			normalized = sum / float64(measured)
		}
		return nil, map[string]any{
			"revision": inv.Revision, "clusterContext": clusterID, "observedAt": time.Now().UTC().Format(time.RFC3339),
			"imageUsages": usages, "workloadGroups": groups,
			"workloads": inv.Workloads, "releaseGroups": releaseGroups, "helmReleases": helm.Releases,
			"drift":  map[string]any{"normalizedScore": normalized, "totalContainers": len(usages), "containerScores": map[string]any{}, "releaseScores": releaseScores, "workloadScores": scores, "repoScores": map[string]any{}},
			"issues": []any{}, "resources": resources, "warnings": inv.Warnings, "subscriptionUri": dashboardURI(req.Session),
		}, nil
	})
}
