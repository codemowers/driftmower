# Developing Rust applications

Follow the language-independent failure-handling rules in `developing/general`: minimal protected blocks, only explicitly expected failures handled locally, and no blanket catches or generic error-to-success fallbacks. Unexpected failures must propagate visibly.

- Build the application with `rocket::build()` and mount related handlers under an explicit prefix. Mounting a `#[get("/")]` handler at `/api/v1/rocket` gives `/api/v1/rocket/` as the application URL.
- Keep runtime settings in `Rocket.toml` or environment variables. Set `ROCKET_CONFIG` when the file is outside the working directory. Configure container listeners to bind `0.0.0.0` on port 8000 so they are reachable outside the container, including debug builds in Compose. A host-only development listener can bind `127.0.0.1`. Choose log verbosity for the environment.
- `rocket_prometheus::PrometheusMetrics` supplies request instrumentation through a Rocket fairing. Attach a clone of the metrics object so instrumentation and export share the same registry. Serve `/metrics` on a separate internal listener sharing that registry, and keep it off the public application listener. Use bounded labels such as route templates and status codes; exclude personal data, credentials, and raw URLs. Declaring `containerPort: 8080` alone does not create that listener.
- For local container development, configure a Compose service with `build: .` and `ports: ["8000:8000"]`. Run `docker compose up --build`, then request `http://localhost:8000/api/v1/rocket/` for the route above. Exclude the local `target` directory from the Docker build context.
- For Skaffold development, declare a build artifact whose image name matches the image in the Kubernetes workload manifest. Discover cluster capabilities and applicable policy bindings before configuring deployment; registry credentials, ingress settings, and domains are environment-specific.

TODO: Concrete Rust shutdown and async dependency integration examples.
