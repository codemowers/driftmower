# Building Python containers

- Install into the container's Python environment instead of adding a separate virtual environment inside it.
- With uv, set `UV_PROJECT_ENVIRONMENT=/usr/local` for that environment.
- Keep the final image limited to the application and required runtime dependencies; follow the shared build rules.

TODO: Exact uv dependency-installation/lockfile commands, compilation needs, and runtime-image selection.
