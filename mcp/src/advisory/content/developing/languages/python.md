# Developing Python applications

Follow the language-independent failure-handling rules in `developing/general`: minimal protected blocks, only explicitly expected failures handled locally, and no blanket catches or generic error-to-success fallbacks. Unexpected failures must propagate visibly.

Virtual environments remain appropriate for local Python development outside containers. For container packaging, see `building/languages/python`.

- Never use `except Exception`, `except BaseException`, or bare `except`. Match concrete, expected exception types at the operation that can handle them. Retry only known transient failures; let programming errors terminate the operation without acknowledging incomplete work. Use `finally`/context managers for resource cleanup.
- Prefer async Python for concurrent I/O, with async-compatible libraries throughout the request path. Do not call blocking database, object-storage, image-processing, or inference operations directly on the event loop.
- Do not use uWSGI master/worker pools, supervisord, or similar process-management stacks as the deployment model for new Python services in Kubernetes. Kubernetes already handles supervision and replicas; it does not need an understudy inside the container.
- Async frameworks such as Sanic fit this model when explicitly run without a worker manager. Use `sanic server:app --host=:: --port=8000 --single-process` or `app.run(host="::", port=8000, single_process=True)`. Sanic's default one-worker configuration still has a main process plus a worker; `--single-process` disables the manager and auto-reloader. See [Running Sanic](https://sanic.dev/en/guide/running/running.html).
- Default to one process and one request/job execution thread per container. Scale with Kubernetes replicas instead of worker processes. A server configured with one worker may still create a supervisor process; inspect its process model.
- Do not assume Python threads parallelize CPU work. Additional threads need a documented, measured reason: the actual operations must release the GIL, as some NumPy, OpenCV, and Pillow operations do. Merely importing one of these libraries does not justify a larger thread pool.
- For existing synchronous workloads, retain a single execution thread until the I/O path can be converted correctly. Async-first is a preference, not a reason to wrap blocking calls in async functions or create unbounded executor pools.
- Bound concurrent tasks, library thread pools, connection pools, and shutdown time. Keep HTTP and queue workers in separate containers/workloads. Runtime housekeeping threads are not additional request/job execution concurrency.
- Keep TLS optional in software and configure it at runtime: disabled for local Compose, enabled with certificate and hostname verification in Kubernetes.

TODO: Concrete configuration, shutdown, and local hot-reload examples.
