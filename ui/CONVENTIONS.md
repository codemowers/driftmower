# UI conventions

The dashboard serves facts to humans. Agents act through MCP directly, so the
UI shows state and copyable commands, not workflows. Keep every view to about
ten MCP tool calls, without pagination.

## Page anatomy

Every page has the same vertical order:

1. **Header.** List pages use `PageHeader` (title, one-line subtitle).
   Resource pages and their subpages use `ResourceHeader` (breadcrumbs, icon,
   title, chips, subtitle). Nothing renders above the header.
2. **Resource navigation.** Workload, Pod and namespace Logs/Network routes
   appear in the sidebar as flat sub-items (Overview, Logs, Network) under the
   section the resource belongs to (Top-level, Namespaces). No resource-name
   level, live meters, tree lines or nested indentation; the section entry
   stays highlighted. Never repeat an Overview/Logs/Network
   strip in the page. Other resource families use `SubpageNav` below the
   header.
3. **Content**: cards in one column, or a main column with an aside.

The page shell is `Page` (`app/components/layout/page.tsx`): a document page
scrolls (`gap-6 px-7 py-8`); `fill` pages (logs, topology) fill the viewport.
Do not write `<main>` by hand.

## Subpages and tabs

- **Subpage** (its own path, listed in resource navigation): a view that needs its own
  requests or a lot of space, such as Logs, Network, SBOM or YAML. Paths are
  path segments, never query parameters: `/topmost-owners/<uid>/logs`,
  `/container-images/<image>/-/<digest>/sbom`.
- **Tab** (`TabBar`, the `?tab` style query parameter): another view of data
  the page has already loaded. Tabs never trigger extra tool calls on their own.
- Never link to a subpage from a card in the middle of the page. Live
  indicators of a subpage (log rate, connection counts) go into its
  resource navigation item.

## Cards

Use `Card` (`app/components/layout/card.tsx`) for every bordered block:

- Shell: `rounded-xl border border-gray-200 bg-white`. No other radius, border
  colour or background for content blocks.
- Header: `title` in the section-label style, optional `meta` (counts, times)
  and `actions` on the right, separated from the body by a border.
- Body: `p-5`, or `flush` for tables and lists that run edge to edge.
- Do not nest bordered cards or boxes. Use flat sections, spacing and row
  separators within a single card. Actions use one `Actions` card containing
  normal buttons.
- Resource kinds already named in breadcrumbs are not repeated as badges.
- A card's title is always inside it, in the header row. Never put a label
  above a bordered box; make the label the box's title instead.
- A list of things (applications, Pods, registries) is rows inside one card,
  not one card per item.
- Section labels outside cards are only for grids of stat tiles, using
  `SectionLabel`. Same style as a card title:
  `text-xs font-semibold uppercase tracking-wider text-muted-foreground`.
- Cards do not repeat navigation: no tiles that only link to a nav section.

## Tables and lists

- Tables live in a `flush` card. Header row: `bg-muted text-xs
  text-muted-foreground`; cells `px-5 py-3`; rows separated by `border-b`.
- Lists of resources link the resource name; identifiers (digests, UIDs,
  purls) use `font-mono text-xs text-muted-foreground` on a second line.
- Labels such as licenses, severities and statuses are badges on the right.

## States

- Loading: `PageLoading` for a whole page, otherwise one muted line
  (`text-sm text-muted-foreground`) inside the card that is loading.
- Errors: `role="alert"` with `text-status-major-label`; say what failed.
- Unknown is not zero: show "unavailable" or "—", never a zero count, when
  data is missing.

## Icons

- One icon per concept, taken from `ICONS` (`app/components/layout/icons.ts`).
  The nav bar, a section's list page and its resource pages show the same
  icon. Add a concept there before using a new icon.
- Every page header carries exactly one icon tile: `PageHeader` and
  `ResourceHeader` require it. Subpages use their resource's icon, or the
  subpage concept's (`logs`, `sbom`, `yaml`).
- No icons in card titles, subpage navigation or table headers; text labels
  carry those. Badges and status chips do not get icons either, except the
  issue-count warning triangle.
- Buttons: icon plus text. An icon-only button needs `aria-label` and `title`.

## Colour and type

- Use the shared neutral palette in `globals.css`: a white page canvas,
  white cards, visible gray separators and dark secondary text. Small labels,
  identifiers and metadata must remain easy to read; do not use pale gray or
  reduced opacity for meaningful text. Gray utilities share the semantic
  surface, border and muted-text tokens so pages keep consistent contrast.

- Status colours come from `status-style.ts` (`SEVERITY_STYLE`,
  `CVE_SEVERITY_STYLE`) and `usageBarColor`; do not invent new ones.
- Bars use `MetricBar`; time series use `TimeSeriesChart`. Vulnerability
  summaries use the same thin bar geometry and show severity counts in a legend.
  CVE/GHSA severities retain yellow/orange/red; capacity thresholds use the
  separate cyan/blue/violet usage palette from `usageBarColor`.
- Text sizes: page title `text-2xl`, card title per the section label,
  body `text-sm`, secondary `text-xs`. Monospace for identifiers and versions.

## Spacing

- `gap-6` between page sections and between cards; `gap-4` inside a card body.
- Two-column layouts: `DetailLayout` (`app/components/layout/detail-layout.tsx`),
  a main column plus an aside of at least 420px and 36% of the width.

## Resource detail layouts

- Namespace, workload and Pod details share `DetailLayout`: expanded kubectl
  commands, then findings, then the resource's own lists in the main column;
  statistics and resource usage stacked in the aside.
  Workload provenance has its own flat section.
- Scope cards in `app/components/scope/` are shared by namespace, workload and
  Pod pages in this order after the findings: Containers (`ImagesCard`), Pods
  (`PodsCard`, not on the Pod page), Volumes (`VolumesCard`, omitted on
  workload/Pod pages without claims). Remaining resource-specific views
  (workload Resources/Descendants/Metadata/History, Pod Ports/Metadata) stay
  as tabs below them.
- Do not display rottenness scores or normalized drift scores anywhere.
  Show observed version differences and counts instead. Container drift sits
  immediately above the technical-debt estimate in Executive Summary.
- Header chips match across scopes: an issue count covering
  both resource issues and image metadata issues.
- Operator-managed stateful workloads (CNPG Cluster, Redpanda, Dragonfly,
  RabbitmqCluster) show +20/50/100% storage commands in their Volumes card
  that merge-patch the custom resource's declared size, as absolute sizes
  like the PVC detail.
- Source repositories split 50:50: license and changelog on the left, images
  on the right. Changelog releases are flat rows in one card; releases
  matching a running version are marked "running" and expanded. Image rows
  show tags and digests inline and link only to images with an image page
  (the running inventory); unused images are plain text.

## Findings

Issues, alerts, security advisories and vulnerabilities render with the same
blocks at every scope: cluster, namespace, workload and Pod
(`app/components/findings/`, scoped by `FindingScope` in
`lib/cluster/scope.ts`). Order: firing alerts (hidden when none on resource
pages), issues, advisories, vulnerabilities. Resource pages show the top five
of each with a "Show all" footer; the cluster-wide Alerts, Advisories and
Vulnerabilities pages show every row. Do not build a per-page variant.
Executive Summary shows the top firing alerts as its top issues; it never
reads the live inventory.
- Image repositories show running versions before deployed-by;
  source links live in their Integrity cell and open the internal source detail.
- Shell arguments stay unquoted when safe. Quote whitespace, shell syntax and
  placeholders. Custom-resource commands always qualify the resource with its
  API group; never guess a plural by appending an s.

- Workload lists sort by weighted issue rank (critical/warning/notice/info:
  27/9/3/1; repeated kinds add logarithmically). Rank is a presentation aid,
  not a security assessment. Version drift is an issue: major, minor, patch
  and stale images remain distinct. Show reported issue-kind badges beneath
  search, with affected workload counts; selected badges filter with OR.
  Missing version data remains unknown. Stale-image findings use the created label, falling back to the image config
  creation time (as on image detail), for declared OCI build age independently of release comparison: no finding through six months,
  then a linear progression through info, notice (12 months), warning (18 months)
  and critical (24 months). A month is 365.25/12 days; missing, invalid or future
  build timestamps remain unknown. Uncomparable release drift is labelled Behind,
  never inferred to be stale without age evidence.
- Pod configuration issues aggregate matching conditions across containers and
  Pods. Show affected-container and Pod counts, not individual container names.
  Keep capability and mounted host-path evidence distinct; repeated mounts or
  capability declarations in one container count once. Counts do not multiply
  issue severity or ranking by replica count.

- Source access failures show an explicit Unauthorized badge in source lists
  and details. Explain upstream 404 ambiguity in its tooltip: a repository
  may be missing or inaccessible to crawler credentials. Missing optional
  files and rate limits do not count as unauthorized access.

- Kata guest-only root, privileged execution, added capabilities and privilege
  escalation are runtime facts, not host-security issues or warning badges.
  Continue evaluating host-facing mounts/namespaces and resource settings.

## Image and process evidence

Build Age prefers the OCI created label, then config JSON creation time, then
latest observed regular-file modification time. Label the file-time fallback as
an estimate. Reuse the artifact page's analysis request for these facts. If any
two available timestamps differ by at least one hour, show a focusable warning
triangle beside the primary age; its tooltip lists the primary and secondary
facts with their sources and full timestamps. Missing or invalid facts remain
unknown, and agreement within one hour does not need a warning. For multiple
platforms, use the oldest config time (or newest file time when no declared time
exists) and include platform identity in the warning details.

Filesystem observations come from the same CycloneDX artifact as packages and
vulnerabilities. SBOM file rows expose MIME type, modification timestamp and ELF
linking evidence; filesystem-only documents remain downloadable and explicitly
state that vulnerability coverage is unknown. ContainerImage labels/config
metadata keep their own lifecycle and are combined only when rendering age.

Static filesystem enumeration and ELF evidence belong to the image artifact page.
Count the full image and retain only the 1,000 newest regular file records; show
when counts are incomplete. Distinguish the config JSON build timestamp from the
latest observed file modification time. Probe known shell paths directly;
presence does not prove runtime execution.
Process monitoring is deferred. Pod pages offer context-scoped kubectl exec
snippets only for detected shells,
using the actual container name and immutable running image digest.

Executive Summary places Container drift and Technical debt immediately after
the header. Container drift counts load independently with a current Prometheus
instant query, without waiting for history. A single Time window dropdown on the right of the
page header, with an accessible name and no visible explanatory label, controls all history charts, defaulting to one week; current counts,
firing alerts and top-five workloads remain current. Effort assumptions are
server environment configuration, with no editable fields in the dashboard. Its drift chart uses aggregated
Prometheus signal history; the
current top-five workloads use a separate bounded instant query, with failures
and unknown coverage shown explicitly. Vulnerability history uses yellow for
High findings and red for Critical findings. Detail history requests only the
selected workload/image and uses the backend's bounded sample resolution.

Pod list cards hide Pods carrying the scanner's `driftmower-scan` label by
default. A Show scan Pods checkbox in the card header reveals them, including
retained terminal scan attempts. Identification uses the observed label, never
Pod names. This is a display filter; agents and direct Pod detail reads retain
the full inventory.

Sign-in preserves the requested local page, including query parameters and
fragment, in the existing window-scoped OIDC transaction state. Only restore it
after callback validation succeeds. Connect from Settings or the root falls back
to Executive Summary. Opening an assigned Chrome profile passes only the local
return path; OAuth transactions and tokens stay within their own window.

A hosted dashboard with one configured MCP endpoint automatically starts browser
OIDC sign-in when no usable session exists, preserving its linked destination.
Attempt it once per endpoint per browser window; clear the attempt after a
successful login. Settings and failed callbacks retain manual Connect without
restarting login. Desktop discovery/profile selection remains manual. Sign out
opens Settings so automatic sign-in does not immediately undo it.

Stacked charts place the No data / No scan series last so it is above observed
series. Technical debt uses a compact chart and one sentence describing version
drift, declared-build-age fallback and highest-image-per-workload aggregation.
Executive Summary scan coverage counts distinct running immutable image digests,
not containers or replicas, with Trivy + files, files only and no scan groups;
legacy Trivy-only evidence stays distinct. It reads Prometheus, honors the page
time window and preserves gaps when scanner inventory or evidence metrics are
unavailable. Partial Trivy coverage remains explicitly limited.

Access-rights views show incomplete rule enumeration as unknown permissions,
not denial. Deduplicate repeated authorizer limitations, and put the affected
review scopes in one expandable detail, naming the empty scope Cluster-wide.

Executive Summary shows its selected time window only in the page header;
chart headers retain units but do not repeat the selected duration. Image scan
coverage sits to the left of Drift over time at a 1:2 width ratio on wide
screens, stacking on narrow screens. Share one capability read for the page.

The Cluster node table includes per-node used/total memory from the existing
cluster-health response, alongside LVM and ephemeral storage. Capacity cells
use MetricBar and Prometheus graph links; missing node memory remains unknown.
Node capacity cells place compact used/total values below the bar (for example,
`4G / 16G`). Node rows encode state in their left border: Ready alone is green,
Ready with scheduling disabled, memory/disk/PID pressure, network unavailable
or legacy out-of-disk is yellow; NotReady is red; unknown readiness stays
neutral. Conditions are extensible: positive states such as EtcdIsVoter and
unclassified conditions stay visible but do not imply faults or change color.
Keep the full state accessible on the row.
In node detail State text, color each condition independently: Ready green,
NotReady red, known adverse conditions yellow, and informational or unclassified
conditions neutral. Use the same rendering in the header and details card.
Node names link to `/cluster/nodes/<name>`; membership and boot timestamps,
labels, host-affinity PVs and the kernel-log placeholder belong to that detail.
