# Deployment networking

- Use service-name discovery in Compose and `service.namespace` discovery in Kubernetes.
- Reuse service names and network ports across environments where practical. Container images and Kubernetes process listeners must support IPv6: listen on `::` (the IPv6 unspecified address) and ensure the runtime also accepts IPv4, or configure separate listeners. Binding only to `0.0.0.0` does not provide IPv6 support in Kubernetes. Local Compose may intentionally use IPv4-only networking and bindings; that alone is not a finding. Inspect Dockerfile defaults and runtime configuration together before judging Kubernetes compatibility.
- Configure application HTTP listeners for IPv6, for example Next.js `HOSTNAME=::`. Service configuration alone does not change the process listener. For operator-managed backing services, follow the target admission policies.
- Bound inter-service calls with connection timeouts and retry with backoff.

- Keep TLS optional in application software through runtime configuration. Local Docker Compose should run without TLS; Kubernetes must enable TLS for all component-to-component traffic, including application HTTP, databases, caches, queues, and object storage. Do not bake TLS enablement, environment-specific certificates, or trust paths into images.
- Follow the target admission-policy guidance for certificate provisioning, issuer selection and workload references. Configure application servers to load the resulting TLS Secret.
- Configure clients to trust the cluster CA and verify hostnames. In namespaces selected by the platform trust bundles, mount `ConfigMap` `cluster-ca-certs` key `ca.crt`, or `trusted-ca-certs` key `ca.pem`, and configure the application's CA trust. Check bundle availability in the target namespace; issuing a certificate alone does not configure client trust.
- Arrange certificate reload or workload restart after renewal. Keep authentication enabled over TLS; encryption alone does not authenticate the calling component.
- Before configuring TLS, use `describe_cluster_capabilities` to discover the cluster's existing ClusterIssuers, their descriptions and reported readiness. Prefer a suitable existing ClusterIssuer over creating an application-specific Issuer or ClusterIssuer. Select it for public or in-cluster TLS using its live description; only configure a new issuer when the available issuers cannot meet the application's requirements. When available, consult `describe_namespace_readiness` for namespace network posture and allowed hostnames.

- Expose browser-facing routes through an Ingress. Keep the admitted certificate DNS names, Ingress TLS hosts, public application URL, and OIDC redirect URIs aligned; use the selected identity provider's provisioned configuration as described in `deploying/security`.
- Route API paths to their own Services where appropriate, keeping background workers and backing-service administration endpoints internal.

TODO: Concrete Ingress and network-policy examples. Consult the live cluster's admission-policy catalog for platform-specific behavior.
