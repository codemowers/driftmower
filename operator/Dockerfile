FROM golang:1.27.4 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY operator ./operator
RUN CGO_ENABLED=0 go build -trimpath -o /operator ./operator/cmd/driftmower-operator
# CA certificates are mounted by the cluster; the binary embeds fallback roots.
FROM scratch
COPY --from=builder /operator /driftmower-operator
USER 65532:65532
ENTRYPOINT ["/driftmower-operator"]
