# Building Rust containers

Use multiple build stages and ship a static binary where applicable, with only necessary runtime files in the final image. For a statically linked Rocket service, use a Rust builder followed by a `scratch` runtime containing the server binary, `Rocket.toml`, and any required runtime assets.

- Copy `Cargo.toml` and the committed `Cargo.lock` before application sources, then use `cargo fetch --locked` and `cargo build --release --locked --target <target>`. For workspaces, include the member manifests needed by Cargo. Keep dependency updates in deliberate source changes; do not run `cargo update` during image builds.
- Cache dependency work separately from frequently changing application code. If prebuilding dependencies with a placeholder application, copy the complete source tree afterward and ensure Cargo rebuilds the real application after replacing placeholders. Keep host `target` artifacts out of the build context with `.dockerignore`.
- Select the target triple and linker for the deployment architecture. For x86-64 GNU/Linux, `--target x86_64-unknown-linux-gnu` with `RUSTFLAGS='-C target-feature=+crt-static'` requests static CRT linking; select an appropriate target and toolchain for other architectures. Native dependencies also need compatible static libraries. Verify the resulting binary has no dynamic interpreter or required shared libraries before choosing `scratch`.
- Copy only the release executable and required runtime assets into the final stage. Set `ROCKET_CONFIG=/app/Rocket.toml` when copying the configuration there, and use an exec-form entrypoint such as `["/server"]` so the application receives container signals directly.
- A `scratch` image has no shell, CA certificate bundle, or other runtime data unless explicitly copied. Include the assets the application's actual dependencies need; use a compatible minimal runtime with the required shared libraries when static linking is unsuitable. Configure a numeric non-root runtime identity and ensure required files are readable by it.
- Choose a maintained Rust toolchain compatible with the application and lockfile. Smoke-test the final image, including startup and any TLS or native-library-dependent paths.

## Sample Dockerfile

The original sample below builds the `hello-rocket` binary for x86-64 and copies it into `scratch`. It retains the historical Rust version and dependency-cache steps verbatim; apply the toolchain, lockfile, and runtime requirements above when adapting it.

```dockerfile
FROM rust:1.67.1 AS build
ENV RUSTFLAGS='-C target-feature=+crt-static'
RUN cargo new /app
WORKDIR /app
RUN cargo update
COPY Cargo.toml /app/
RUN cargo fetch
RUN cargo build --release --target x86_64-unknown-linux-gnu
COPY src/main.rs /app/src/main.rs
RUN cargo build --release --target x86_64-unknown-linux-gnu

FROM scratch
WORKDIR /
ENV ROCKET_CONFIG=/app/Rocket.toml
COPY Rocket.toml /app/
COPY --from=build /app/target/x86_64-unknown-linux-gnu/release/hello-rocket /server
ENTRYPOINT ["/server"]
```
