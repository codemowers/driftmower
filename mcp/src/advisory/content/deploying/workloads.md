# Kubernetes workload design

- Keep one process per container; avoid application-level forking or multiprocessing to orchestrate workloads. A server master plus one worker is still two processes. Multiple threads may share that process's address space and metrics registry where justified, so Prometheus scrapes cover the whole container's application work. For Python, prefer async I/O and default to one request/job execution thread; additional threads require workload-specific evidence of GIL release (see `developing/languages/python`).
- Use Kubernetes Lease objects for leader election.
- Use CronJobs for schedules at a resolution of at least one minute.
- Run one-off work as Jobs or separate Pods instead of inside long-lived application Pods.

- Run HTTP servers and background workers as separate workload types so their replica counts can scale independently. Run the actual application directly in the foreground as PID 1 with exec-form ENTRYPOINT/CMD and let Kubernetes manage restarts. Avoid dumb-init, tini, s6, supervisord, and similar process wrappers for new services. Document narrowly scoped exceptions when porting legacy applications whose process model cannot reasonably be changed.
- Set a termination grace period that accommodates bounded request draining and job completion or return to the queue. Workers must tolerate interrupted jobs and repeated delivery.
- Package database migrations and maintenance commands with the application. Run them as one-off Jobs using the same image digest and appropriate release configuration as the application.
- Coordinate migration execution so application replicas do not race to perform the same migration; plan schema changes to support overlapping application versions during rollouts.

- Set CPU and memory requests and limits appropriate to each component, including heavier media-processing workers. Use `describe_namespace_readiness`, when advertised, to inspect quotas and defaults before sizing workloads.
- Reuse an application image for its HTTP service and background worker when they share code, selecting separate startup commands and resource budgets. Workers that expose no network interface do not need a Service.
- Declare messaging resources through the operator, such as `Topic.cluster.redpanda.com`, and choose partition counts and retention deliberately. Compacted topics suit keyed state updates; they do not preserve every historical event. Design replay and deletion behavior for the chosen retention policy.

TODO: Deployment rollout strategy, job concurrency/retries, and detailed leader-election examples.
