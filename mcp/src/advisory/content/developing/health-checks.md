# Application health checks

- Provide HTTP health/readiness endpoints such as `/health` and `/ready` for local and Kubernetes use.
- Serve all readiness, liveness, and startup-check endpoints on an internal listening port separate from the application port used by Ingress. They may share the internal Prometheus metrics port. Do not register these endpoints on the public application listener; a catch-all Ingress must not expose them.
- Keep checks quick and inexpensive, without dependencies on external services.
- Use readiness to indicate whether incoming traffic can be handled.
- Avoid liveness probes by default. Add them only when there is a demonstrated need; Java is one workload where they have proved useful.

TODO: Specify startup-check behavior and concrete response contracts.
