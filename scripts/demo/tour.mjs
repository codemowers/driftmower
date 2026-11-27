// Demo tour: one entry per shot, played in order. Fast-paced: short punchy
// lines, quick cuts; each shot lasts about as long as its narration.
//
//   nav     sidebar entry (its accessible name) to click
//   open    CSS selector of a link inside the page to click (first visible match)
//   caption lower-third text burned into the video
//   say     narration synthesized through TTS (omit for a silent shot)
//   hold    minimum seconds on screen; narration extends it when longer
//   scroll  pixels to scroll the content while holding (0 = stay at the top)
//
// A shot whose link is missing (capability-gated page, empty table) is skipped
// with a warning, so the tour survives differences between clusters.
export const tour = [
  {
    nav: "Executive Summary",
    caption: "How far has your cluster drifted?",
    say: "This is Driftmower. One screen. How far your entire cluster has drifted from upstream. Drift, CVEs, service accounts, technical debt. All of it straight from Prometheus.",
    hold: 3,
    scroll: 900,
  },
  {
    nav: "Top-level",
    caption: "Workloads by owner",
    say: "Workloads? Grouped by who actually owns them. One deployment, one row. Not forty pods.",
    hold: 2,
  },
  {
    open: 'main a[href^="/topmost-owners/"]',
    caption: "Every image, every version",
    say: "Click in. Every image, every version, and exactly how far behind upstream it is.",
    hold: 2,
    scroll: 600,
  },
  {
    nav: "Container Images",
    caption: "Straight from containerd",
    say: "Where do the images come from? Containerd. On every node. By digest, not some tag that lies to you. The image labels get read too, and here roughly half of the images say exactly which Git repository they came from. Boom. Linked to source. Zero config.",
    hold: 3,
    scroll: 400,
  },
  {
    open: 'main a[href^="/container-images/"]',
    caption: "Changelogs + advisories + Trivy",
    say: "Source on GitHub? Changelog, pulled in. Security advisories, pulled in. Then Trivy scans every image for CVEs. Image level. Component level. Layers of coverage.",
    hold: 3,
    scroll: 700,
  },
  {
    nav: "Vulnerabilities",
    caption: "Unknown is not clean",
    say: "Every CVE in the cluster, one list. No scan yet? That's unknown. Not clean. Unknown.",
    hold: 2,
    scroll: 500,
  },
  {
    nav: "Source Repositories",
    caption: "Watching upstream",
    say: "Upstream releases, changelogs, advisories. That's how it knows you're three versions behind.",
    hold: 2,
  },
  {
    nav: "Service accounts",
    caption: "Who can do what",
    say: "Who can do what? Service accounts, users, groups, admission policies. Filtered by your own permissions.",
    hold: 2,
  },
  {
    nav: "Alerts",
    caption: "Alerts that explain themselves",
    say: "Alerts that tell you what broke, why it matters, and what to check next. Novel concept.",
    hold: 2,
  },
  {
    nav: "Coding agent",
    caption: "Same facts, over MCP",
    say: "And it's all on MCP, so your coding agent gets the exact same facts. Driftmower. Go look at your cluster.",
    hold: 3,
  },
]
