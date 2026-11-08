# Direct upstream artifact mounts tested on ee-lte-1 produced empty directories.
# Package extracted DB files as a standard OCI filesystem image instead.
# Track direct upstream Trivy DB artifact mounts here:
# https://github.com/containerd/containerd/issues/11381
# Revisit this packaging workaround once supported by the cluster runtime.
# Skaffold runs this in Kaniko without a layer cache. Rebuild to refresh the DBs.
FROM aquasec/trivy:0.75.0 AS database
RUN trivy image --no-progress --cache-dir /database --download-db-only \
    && trivy image --no-progress --cache-dir /database --download-java-db-only \
    && chmod -R a+rX /database/db /database/java-db
FROM scratch
COPY --from=database /database/db /db
COPY --from=database /database/java-db /java-db
