FROM node:22-slim AS assets
WORKDIR /app
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui ./
RUN npm run build

FROM golang:1.27.4 AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY ui/cmd ./ui/cmd
COPY desktop/dashboard ./desktop/dashboard
RUN CGO_ENABLED=0 go build -o /dashboard ./ui/cmd/driftmower-dashboard

# CA certificates are mounted by the cluster; the binary embeds fallback roots.
FROM scratch
WORKDIR /app
COPY --from=server /dashboard /dashboard
COPY --from=assets /app/static/out /app/public
ENV LISTEN_ADDR=[::]:8080
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/dashboard"]
