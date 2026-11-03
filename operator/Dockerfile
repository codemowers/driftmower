# Build context: the repository root, where go.mod is.
FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY operator/cmd operator/cmd
COPY operator/internal operator/internal
RUN go test ./operator/...
ARG VERSION=dev
RUN CGO_ENABLED=0 \
    go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -tags 'netgo osusergo' \
    -o . ./operator/cmd/...

# Both commands share the image; the crawler runs with its own command.
FROM scratch
COPY --from=builder /app/driftmower-operator /app/driftmower-crawler /
USER 65532:65532
EXPOSE 8080 8081
ENTRYPOINT ["/driftmower-operator"]
