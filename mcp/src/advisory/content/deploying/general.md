# General deployment guidance

- Write Kubernetes, Helm and Compose YAML with indented block mappings and sequences, with each field or item on its own line. Do not compress YAML into inline JSON or flow collections to save space. Preserve explicit empty collections (`{}` or `[]`) where their empty value is meaningful.
- Use Kubernetes for production and Compose for local development, keeping their configuration and service structure aligned.
- Version-control environment configuration and automate setup, tests, and deployment.
- Never commit `kind: Namespace` resources to application repositories, Helm charts, Kustomize overlays, or GitOps manifests. Deleting or pruning a managed namespace can cascade-delete every workload and its data, including unrelated applications. Namespace provisioning and deletion belong to the platform lifecycle, outside the application release; do not adopt existing namespaces into application ownership.
- Before removing an existing Namespace declaration, inspect the live namespace's Helm, Argo CD, Flux, Skaffold and other ownership/tracking metadata and the owning controller's release inventory. Remove the declaration only after safely detaching it from application ownership and pruning. Removing labels alone does not remove a namespace from Helm release history or a GitOps inventory. Preserve the namespace and its workloads; never delete/recreate it. If safe detachment cannot be established, keep the declaration until the owning release/controller can be migrated safely.
- Use Kubernetes workload primitives instead of implementing an orchestrator inside the application.

- Separate image building, release configuration, and runtime execution. Chart defaults on the main development branch may use `latest`; do not flag that alone as a defect. At tag/release time, substitute immutable image digests or release identifiers and record the source and configuration revisions. A deployed release combines that immutable image with its deployment configuration.
- Roll back by selecting a previous release, rather than editing running containers. Check database schema compatibility before rolling back application code.
- Use `list_accessible_namespaces` to discover deployment targets and `list_admission_policies` to inspect platform constraints. When advertised, `describe_namespace_readiness` reports namespace readiness and `describe_cluster_capabilities` reports platform capabilities.
- Treat the target cluster's admission-policy descriptions and matching policy/binding specifications as the source of truth for platform-assigned settings and prerequisite resources. Omit policy-owned fields from application manifests instead of restating their defaults. Check applicability to the resource and namespace; policies can be disabled or cluster-specific. Where no applicable policy supplies a required setting, configure it explicitly. Keep cluster policy details in the discoverable policies rather than duplicating them in bundled advisories.

- Use Helm capability checks for optional platform APIs instead of adding feature flags for infrastructure availability. In particular, conditionally render PodMonitor and PrometheusRule resources on their respective `monitoring.coreos.com/v1/<Kind>` capabilities; see `deploying/observability`. Application charts must not install the platform operator or its CRD definitions.

- Parameterize chart namespaces with `.Release.Namespace` and environment-specific hostnames through values. Keep Service selectors aligned with Pod labels and Service target ports aligned with application listeners.

TODO: Rollout, rollback, and release-promotion procedures.
