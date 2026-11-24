# UI conventions

The dashboard presents facts and copyable commands to humans; agents act through
MCP. Keep each view to about ten MCP calls, without pagination.

## Page structure and navigation

- Use `Page` (`app/components/layout/page.tsx`), never a handwritten `<main>`.
  Document pages scroll (`gap-6 px-7 py-8`); `fill` pages fill the viewport.
- Order: header, resource navbar, content. Nothing precedes the header.
  Lists use `PageHeader`; resources/subpages use `ResourceHeader` with
  breadcrumbs, icon, title, chips and subtitle.
- The sidebar contains fixed section links only. Never add expansion, nested
  resources, subpages or page-section links. Detail pages and descendants belong
  in breadcrumbs; resource links use `SubpageNav` below the header.
- Subpages needing separate requests or space use path segments, e.g.
  `/topmost-owners/<uid>/logs` or `/container-images/<image>/-/<digest>/sbom`.
  `TabBar`/`?tab` switches already-loaded data without extra calls.
- No subpage links inside content cards or navigation-only tiles. Live subpage
  indicators (log rate, connections) belong in the page navbar.

## Shared presentation

- Every bordered content block uses `Card` (`app/components/layout/card.tsx`):
  `rounded-xl border border-gray-200 bg-white`. Its header contains the title,
  optional `meta` and right-aligned `actions`; body uses `p-5` or `flush`.
- No nested bordered boxes. Use flat sections and row separators; lists are rows
  in one card. Group action buttons in one `Actions` card. Never place a card
  title outside its header. Outside-card `SectionLabel` is only for stat grids.
- Section/card titles: `text-xs font-semibold uppercase tracking-wider
  text-muted-foreground`. Page titles: `text-2xl`; body: `text-sm`; secondary:
  `text-xs`; identifiers and versions: monospace. Do not repeat resource kinds
  from breadcrumbs as badges.
- Tables use `flush` cards, `bg-muted text-xs text-muted-foreground` headers,
  `px-5 py-3` cells and `border-b` row separators. Link resource names; put
  digests, UIDs and purls on a second line in `font-mono text-xs
  text-muted-foreground`. License, severity and status badges go on the right.
- Use `gap-6` between sections/cards and `gap-4` inside bodies. `DetailLayout`
  supplies main/aside columns; the default aside is at least 420px and 36% wide.
- Loading: `PageLoading` for a page, otherwise one muted line in its card.
  Errors use `role="alert"`, `text-status-major-label` and name the failure.
  Missing data is unavailable/—, never zero.
- Use the shared neutral palette in `globals.css`: white canvas/cards, visible
  gray separators and readable dark secondary text. No pale gray or reduced
  opacity for meaningful labels, identifiers or metadata.
- Status colors come from `status-style.ts` (`SEVERITY_STYLE`,
  `CVE_SEVERITY_STYLE`); capacity colors from `usageBarColor` (cyan/blue/violet).
  Use `MetricBar` and `TimeSeriesChart`. Vulnerability summaries use thin bars
  with severity-count legends and yellow/orange/red CVE/GHSA colors. Category
  series use the shared palette. Stack No data / No scan last, above observations.
- `ICONS` (`app/components/layout/icons.ts`) defines one icon per concept, shared
  across sidebar/list/detail. Each page header has exactly one icon tile;
  subpages may use their resource or subpage concept. No icons in card titles,
  subpage nav, table headers or badges except the issue-count warning triangle.
  Buttons use icon plus text; icon-only buttons need `aria-label` and `title`.

## Resource details and findings

- Namespace/workload/Pod pages use `DetailLayout`: expanded kubectl commands,
  findings, then resource lists in main; statistics/usage in aside. Workload
  provenance is a flat section. Issue-count chips include resource and image
  metadata issues consistently across scopes.
- Shared `app/components/scope/` cards follow findings: Containers (`ImagesCard`),
  Pods (`PodsCard`, except on Pod pages), Volumes (`VolumesCard`; omit on
  workload/Pod pages without claims). Resource-specific Resources, Descendants,
  Metadata, History and Ports stay in tabs below.
- Shared `app/components/findings/` blocks use `FindingScope` from
  `lib/cluster/scope.ts`. Order: firing alerts, issues, advisories, vulnerabilities.
  Hide empty resource alerts; show top five per resource with Show all. Global
  Alerts/Advisories/Vulnerabilities show every row; no per-page variants.
- Never display rottenness or normalized drift scores; show observed version
  differences/counts. Image repositories place running versions before
  deployed-by; source links in Integrity open internal source details.
- Workloads sort by weighted issue rank (critical/warning/notice/info: 27/9/3/1;
  repeated kinds grow logarithmically). Rank is presentation, not a security
  assessment. Show issue-kind filters/counts below search; selection uses OR.
- Keep major/minor/patch/stale drift distinct. Stale issues use the OCI created
  label, then config creation time, independently of release comparison: none
  through six months, then linear info, notice (12), warning (18), critical (24).
  A month is 365.25/12 days. Missing/invalid/future dates stay unknown;
  uncomparable release drift is Behind, not stale without age evidence.
- Aggregate Pod configuration conditions across containers/Pods; show counts,
  not individual names. Keep capability and host-path evidence distinct,
  deduplicate per container, and never multiply severity/rank by replicas.
  Kata guest-only root, privileged execution, capabilities and escalation are
  runtime facts, not host-security warnings; still assess host-facing mounts,
  namespaces and resources.
- Operator-managed stateful workloads (CNPG Cluster, Redpanda, Dragonfly,
  RabbitmqCluster) offer +20/50/100% storage merge patches on their CR's declared
  size in Volumes. Use fixed absolute sizes, as on PVC detail.
- Shell arguments stay unquoted when safe; quote whitespace, syntax and
  placeholders. Qualify CR resources with their API group; never guess plurals.

## Images, sources and vulnerabilities

- Source details split 50:50: license/changelog left, images right. Releases are
  flat rows in one card; running versions are marked running and expanded.
  Image rows show tags/digests inline; link only running-inventory images with
  a detail page, leaving unused images as text.
- Source access failures show Unauthorized on lists/details. Its tooltip notes
  upstream 404 may mean missing or inaccessible to crawler credentials; missing
  optional files and rate limits are not unauthorized access.
- Build Age prefers OCI created label, config creation time, then latest regular
  file modification time (label this fallback an estimate). Reuse artifact
  analysis. If two valid timestamps differ by at least one hour, show a focusable
  warning triangle with sources/full timestamps. For multiple platforms use the
  oldest config time, or newest file time without declared time, and include
  platform identity. Missing/invalid facts stay unknown; agreement needs no warning.
- Filesystem, package and vulnerability evidence share one CycloneDX artifact.
  File rows expose MIME, modification time and ELF linking. Count the full image,
  retain only 1,000 newest regular-file records and mark incomplete counts.
  Config timestamps remain distinct from file timestamps; labels/config retain
  their own lifecycle and combine only for displayed age. Filesystem-only reports
  remain downloadable with vulnerability coverage explicitly unknown.
- Static filesystem/ELF evidence belongs on image artifacts. Probe known shells
  directly; presence does not prove execution. Process monitoring is deferred;
  Pod exec snippets use detected shells, actual container names, immutable running
  digests and the selected kubectl context.
- Vulnerability lists show one affected image plus a +N more link to CVE detail.
  Details show severity/CVSS, image digests, packages/installed/fixed versions,
  workloads and references. Use batched scan findings; fetch full SBOMs only on
  explicit SBOM views/downloads. Keep incomplete coverage visible.
- Pod cards hide the observed `driftmower-scan` label by default. A Show scan Pods
  checkbox reveals all scan attempts, including terminal ones. Never identify by
  name; this display filter does not restrict agents or direct Pod detail reads.

## Executive Summary and history

- Read Prometheus signals and firing alerts, never live inventory. Top firing
  alerts are the top issues. Container drift and then Technical debt immediately
  follow the header; current drift counts load independently of history.
- One accessible Time window dropdown at header right, without a visible label,
  controls all history (default one week). Do not repeat durations in charts;
  keep units. Current counts, alerts and top-five workloads remain current.
- Drift history uses aggregated signals; current top-five workloads use a separate
  bounded instant query. Show failures/unknown coverage. Effort assumptions are
  server environment configuration, never editable UI fields. Technical debt has
  a compact chart and one sentence about version drift, declared-age fallback
  and highest-image-per-workload aggregation.
- Scan coverage counts distinct running immutable digests, not replicas: Trivy +
  files, files only, no scan; legacy Trivy-only stays distinct. Honor the time
  window, preserve missing-metric gaps and explain partial Trivy coverage.
  On wide screens coverage sits left of Drift over time at 1:2; stack on narrow
  screens. Share one capability read. Vulnerability history uses yellow High/red
  Critical. Detail history scopes to the selected workload/image and backend's
  bounded sample resolution.

## Nodes and access rights

- Node tables reuse cluster-health memory/LVM/ephemeral-storage data. Capacity
  uses `MetricBar`, compact used/total labels (e.g. `4G / 16G`) and Prometheus
  links; missing memory stays unknown. Link names to `/cluster/nodes/<name>`;
  detail holds membership/boot times, labels, host-affinity PVs and kernel-log
  placeholder.
- Node row left borders: Ready green; Ready with disabled scheduling, pressure,
  network unavailable or legacy out-of-disk yellow; NotReady red; unknown neutral.
  Positive (e.g. EtcdIsVoter) and unclassified conditions remain visible/neutral.
  Keep full state accessible; color each detail condition consistently in header
  and details (Ready green, NotReady red, adverse yellow, informational neutral).
- Incomplete RBAC enumeration means unknown permissions, not denial. Deduplicate
  authorizer limitations into one expandable review-scope detail; empty scope is
  Cluster-wide. Sort rights by fully qualified `group/Kind` (core: `Kind`).
  Kind/verb labels use monospace: create yellow, reads neutral, mutations,
  privileged verbs and wildcards red. Shared verb filtering includes wildcards.
- Merge adjacent equal namespace cells, one namespace per line. Keep labels sticky
  within their merged cell; no intermediate scroll container trapping stickiness.
- User details split 50:50: effective-rights cards left, kubectl commands right.
  Show memberships/removal commands once; group names in command titles use
  monospace. Commands stay flat/visible, one per existing local group without a
  selector. Local-email commands use `username@example.com`, with no editing
  input. Add to an existing local group comes last.
- Coding agent splits 50:50 on desktop: selectable servers left, selected server's
  add commands right; stack on small screens. Registration example goes below.

## Sign-in

- Preserve the requested local path/query/fragment in window-scoped OIDC state;
  restore only after validated callback. Connect from Settings/root defaults to
  Executive Summary. Assigned Chrome profiles receive only the local return path;
  OAuth state/tokens never cross windows.
- Hosted single-endpoint dashboards automatically start OIDC once per endpoint
  per window without a usable session; clear the attempt on success. Settings
  and failed callbacks keep manual Connect; desktop discovery/profile choice
  stays manual. Sign out opens Settings to avoid immediate automatic login.
- Share concurrent callback processing so one-time state is consumed once.
  Missing state permits one fresh sign-in per endpoint/window with the saved
  destination; repeated failures and token/issuer verification errors stay
  visible. Never accept unmatched callbacks or fall back to anonymous.
