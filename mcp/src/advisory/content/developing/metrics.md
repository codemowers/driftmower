# Application metrics

- Expose Prometheus metrics, using the framework's integration when available.
- Keep all application execution in one process, optionally with multiple threads sharing its address space. Update one shared, thread-safe metrics registry so each scrape represents all application work in the container, rather than whichever forked worker happened to answer. Shared memory alone does not aggregate separate registries; every execution path must use the shared registry.
- Serve metrics on a separate internal listening port from public application traffic; readiness, liveness, and startup-check endpoints may share this port. Do not register metrics or health-check endpoints on the public application listener, where an Ingress catch-all route could expose them.
- Never include PII or sensitive information in metric names, labels, values, help text, or exemplars. Exclude user identities, email addresses, IP addresses, credentials, tokens, request/response bodies, and raw URLs or query strings. Use bounded, non-sensitive categories such as route templates, operation names, and status codes instead of individual identifiers.
- Measure request latency, request/response sizes, and useful business activity such as import throughput. Keep label cardinality manageable.
- Choose measurements that support alerting.
- Leave container memory and filesystem usage to runtime monitoring instead of duplicating it in the application exporter.
