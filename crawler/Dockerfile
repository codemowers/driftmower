# Build context: the repository root, where go.mod is.
FROM golang:1.27.4-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY crawler/cmd crawler/cmd
COPY crawler/internal crawler/internal
COPY internal internal
RUN go test ./crawler/... ./internal/...
ARG VERSION=dev
RUN CGO_ENABLED=0 \
    go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o . ./crawler/cmd/...

FROM scratch
COPY --from=builder /app/driftmower-crawler /
USER 65532:65532
EXPOSE 8080 8081 8082
ENTRYPOINT ["/driftmower-crawler"]
