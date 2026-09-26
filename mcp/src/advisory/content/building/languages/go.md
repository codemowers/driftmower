# Building Go containers

Use multiple build stages and ship a static binary where applicable, with only necessary runtime files in the final image.

- Copy `go.mod` and `go.sum` before application sources and run `go mod download` so dependency downloads can be cached independently of source changes.
- Build with `CGO_ENABLED=0` for applications whose dependencies support running without CGo. The `-ldflags="-s -w"` flags omit symbol and debug information to reduce binary size. Applications requiring CGo need a compatible compiler and runtime libraries or a verified static-linking setup.
- Copy required templates and static assets alongside the executable. Their paths must match the application's runtime file lookups.
- Use `GIN_MODE=release` for deployed Gin applications and an exec-form entrypoint so the server receives container signals directly. `EXPOSE` documents ports; the application must actually bind its HTTP and internal metrics listeners.
- A `scratch` image contains only explicitly copied files. Add CA certificates or other runtime data when required, configure a numeric non-root runtime identity, and verify the final image starts and serves its assets.

## Sample Dockerfile

The original sample below is preserved verbatim. Choose a maintained Go toolchain compatible with the application when adapting it.

```dockerfile
FROM golang:1.23-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd/
COPY templates ./templates/
COPY static ./static/
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app/server ./cmd

FROM scratch
WORKDIR /
COPY --from=build /app/server /server
COPY --from=build /app/templates /templates
COPY --from=build /app/static /static
ENV GIN_MODE=release
EXPOSE 8000 8080
ENTRYPOINT ["/server"]
```
