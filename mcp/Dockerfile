# Build context: the repository root, where go.mod is.
FROM golang:1.26-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY mcp/cmd ./mcp/cmd
COPY mcp/internal ./mcp/internal
COPY internal ./internal

ARG BUILD_REVISION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${BUILD_REVISION}" -o /out/driftmower-mcp ./mcp/cmd/driftmower-mcp

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/driftmower-mcp /driftmower-mcp
USER 1000:1000
EXPOSE 3000 3001
ENTRYPOINT ["/driftmower-mcp"]
