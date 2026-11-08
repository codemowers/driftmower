FROM node:22-slim AS assets
WORKDIR /app
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui ./
RUN npx next build static --webpack

FROM golang:1.26.10 AS server
WORKDIR /src
COPY ui/cmd/driftmower-dashboard/main.go ./main.go
RUN CGO_ENABLED=0 go build -o /dashboard main.go

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=server /dashboard /dashboard
COPY --from=assets /app/static/out /app/public
ENV LISTEN_ADDR=[::]:8080
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/dashboard"]
