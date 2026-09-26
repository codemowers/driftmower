# Local development

- Prefer working through the project's Skaffold or Docker/Compose environment for development, dependency management, builds, and tests. Coding agents must not install application runtimes, package dependencies, backing services, or other components on the host for their own use. Install dependencies in container images. Edit dependency manifests and lockfiles directly; lockfile-only package-manager commands are acceptable when they do not install host components. Reuse existing host tools for orchestration and editing.
- Use Docker Compose for local development and integration testing. Mirror the Kubernetes service layout and environment-variable names; align names and ports where practical. IPv4-only Compose networking and explicit local listener overrides are acceptable, provided the image and Kubernetes runtime support IPv6. Do not repeat environment defaults already supplied by the image or application.
- Run local Compose without TLS. Keep TLS optional in software; enable and verify it in Kubernetes through deployment configuration.
- Use local `.env` files without committing them or other secrets.
- Enable hot reload through development volume mounts.
- Keep application and base dependencies aligned across development, testing, and production. Development images may include debugging tools omitted from production.
- Document Compose startup and Kubernetes deployment steps.
