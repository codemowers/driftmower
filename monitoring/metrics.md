# Drift metrics

Prometheus scrapes every five minutes. Estimates of hours and dollars remain client calculations.

- `driftmower_version_releases_behind`: known, nonnegative newer-release count. Unknown comparisons have no sample.
- `driftmower_version_status`: value 1 for the current `status` (`known` or `unknown`) and `reason` (`known`, `no_source_match`, `not_crawled`, `crawl_error`, `unrecognized_version`, `no_comparable_release`).
- `driftmower_image_created_timestamp_seconds`: Unix seconds from `org.opencontainers.image.created` in OCI labels or annotations. Missing or invalid values are absent. There is no image-config, CRD-creation, or filesystem-time fallback.
- `driftmower_version_checked_timestamp_seconds`: last source crawl, absent before the first crawl.
- `driftmower_version_container_count`: observed container count.

Metrics include namespace, root workload identity, and image reference. The timestamp describes the image build, not when a workload started or an image was pulled. Publisher-supplied timestamps are not independently verified.

Example alert expression for images older than 90 days:

```promql
time() - driftmower_image_created_timestamp_seconds > 90 * 24 * 60 * 60
```

Unknown image build timestamps can be selected separately:

```promql
driftmower_version_container_count
unless on (namespace, uid, image)
driftmower_image_created_timestamp_seconds
```

These are expressions to use with your alerting policy; no alert threshold or receiver is installed. Historical samples from before this change may still contain the former -1 sentinel. The dashboard retains compatibility with those samples.
