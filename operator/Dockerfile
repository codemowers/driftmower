FROM golang:1.26.10 AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal ./internal
COPY operator ./operator
RUN CGO_ENABLED=0 go build -trimpath -o /operator ./operator/cmd/driftmower-operator
# CA certificates are mounted by the cluster.
FROM scratch
COPY --from=builder /operator /driftmower-operator
USER 65532:65532
ENTRYPOINT ["/driftmower-operator"]
