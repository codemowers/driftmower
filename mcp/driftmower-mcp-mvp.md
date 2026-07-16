# Driftmower MCP Server — MVP Scope and Requirements

## 1. Purpose

Build a small standalone MCP server that exposes analytical data produced by the existing Driftmower cluster analyzer to IDE and coding agents.

The MCP server allows a DevOps engineer to ask questions such as:

> What's up with Memelord?

The agent can query Driftmower through MCP, receive structured analysis, and then use its normal IDE capabilities to update the open Terraform, Helm, Helmfile, Argo CD, Flux, or Kubernetes configuration.

The MCP server does not analyze the live cluster and does not modify infrastructure.

---

## 2. System Context

Driftmower already:

- analyzes Kubernetes clusters;
- creates immutable report snapshots;
- stores workloads related to each report;
- treats deployed Helm charts as workloads;
- calculates information such as deployed versions, latest known versions, age, drift, and other findings;
- persists the results in SQLite.

The MCP server is a separate application that reads Driftmower's database.

```text
Kubernetes clusters
        |
        v
Driftmower analytical engine
        |
        | writes report snapshots
        v
SQLite database
        ^
        | read-only
        |
Driftmower MCP server
        |
        v
IDE / coding agent
```

---

## 3. Responsibility Boundaries

### 3.1 Driftmower analytical engine

The existing engine remains responsible for:

- connecting to Kubernetes clusters;
- discovering workloads;
- detecting Helm releases and container images;
- resolving deployed versions;
- resolving latest known versions;
- calculating drift and other findings;
- building report snapshots;
- persisting data to SQLite.

### 3.2 MCP server

The MCP server is responsible for:

- exposing Driftmower data through MCP tools;
- searching workloads in stored reports;
- selecting the latest completed report snapshots;
- returning structured, agent-friendly results;
- including report timestamps so the agent knows how fresh the data is;
- sanitizing and limiting responses.

### 3.3 IDE or coding agent

The IDE agent is responsible for:

- understanding the user's natural-language request;
- calling the MCP server;
- optionally querying live state using `kubectl`, `helm`, Flux, Argo CD, or other tools;
- locating the relevant infrastructure configuration in the open workspace;
- modifying Terraform, Helm, Helmfile, Argo CD, Flux, or Kubernetes files;
- showing the resulting diff;
- asking for confirmation where required by the IDE workflow.

---

## 4. MVP User Workflow

### Step 1: Ask about a workload

The DevOps engineer has an infrastructure repository open and asks:

> What's up with our Memelord?

The coding agent calls the MCP server:

```text
search_workloads(query="memelord")
```

The server searches workload names using a case-insensitive substring match in the latest completed report snapshot for each cluster.

It may return one or several matching workloads.

Example agent response:

> Driftmower found two Memelord workloads.
>
> Production uses Helm chart version `8.1.0`; the latest known version is `8.3.0`.
>
> Staging already uses `8.3.0`.
>
> The production analysis snapshot was created today at 10:00 UTC.

### Step 2: Update the infrastructure configuration

The user asks:

> Update the production deployment config.

The coding agent:

1. uses the previous MCP result as context;
2. searches the open workspace for the Memelord deployment;
3. identifies where version `8.1.0` is declared;
4. changes it to `8.3.0`;
5. shows the diff.

The MCP server does not edit files.

---

## 5. MVP Scope

The MVP contains:

- one standalone MCP server;
- direct read-only access to Driftmower's SQLite database;
- one MCP tool: `search_workloads`;
- case-insensitive substring matching by workload name;
- searches only within the latest completed report snapshot for each cluster;
- support for multiple matching workloads;
- structured workload analysis results;
- report and snapshot timestamps;
- configurable maximum result count;
- local MCP transport, preferably `stdio`;
- no authentication for the local POC.

---

## 6. MCP Tool

## `search_workloads`

Find workloads whose names contain the supplied query in the latest completed report snapshot for each cluster.

### Input

```json
{
  "query": "memelord",
  "limit": 20
}
```

### Input requirements

- `query` is required.
- `query` must not be empty.
- Matching is case-insensitive.
- Matching uses substring semantics.
- `limit` is optional.
- The default limit is `20`.
- The server must enforce a maximum limit.

### Example output

```json
{
  "query": "memelord",
  "matches": [
    {
      "workloadId": "workload-123",
      "name": "memelord",
      "kind": "helm",
      "cluster": "production",
      "namespace": "memes",
      "analysis": {
        "observedVersion": "8.1.0",
        "latestKnownVersion": "8.3.0",
        "status": "outdated",
        "versionsBehind": 2,
        "ageDays": 410,
        "severity": "medium",
        "findings": [
          "chart_outdated",
          "base_image_eol"
        ]
      },
      "snapshot": {
        "reportId": "report-100",
        "createdAt": "2026-07-15T10:00:00Z"
      }
    },
    {
      "workloadId": "workload-456",
      "name": "memelord",
      "kind": "helm",
      "cluster": "staging",
      "namespace": "memes",
      "analysis": {
        "observedVersion": "8.3.0",
        "latestKnownVersion": "8.3.0",
        "status": "current",
        "versionsBehind": 0,
        "ageDays": 40,
        "severity": null,
        "findings": []
      },
      "snapshot": {
        "reportId": "report-101",
        "createdAt": "2026-07-15T10:05:00Z"
      }
    }
  ]
}
```

---

## 7. Snapshot Semantics

Reports are immutable analysis snapshots.

A workload may therefore exist in many historical reports. The default workload search must not return every historical occurrence.

For the MVP:

> Search workloads only in the latest completed report for each cluster.

The result must include:

- report ID;
- report creation timestamp;
- cluster identity;
- analyzed or observed workload version.

This allows the coding agent to distinguish analyzed state from live state.

The MCP server must not claim that the snapshot represents the current live cluster state.

A coding agent may independently compare the MCP result with data from:

- `kubectl`;
- `helm`;
- Argo CD;
- Flux;
- Terraform state;
- another live infrastructure source.

---

## 8. Database Access Requirements

The MCP server must:

- open SQLite in read-only mode;
- never insert, update, or delete data;
- ignore incomplete or failed reports;
- query only completed reports;
- handle concurrent reads while the analytical engine writes new reports;
- use parameterized SQL;
- avoid exposing arbitrary SQL execution through MCP;
- enforce bounded result sizes;
- return a clear error when the database is unavailable or incompatible.

SQLite WAL mode is recommended for the analytical engine if concurrent readers and writers are expected.

---

## 9. Internal Structure

The MCP handler should not contain raw SQL directly.

Recommended internal structure:

```text
MCP tool handler
      |
      v
Workload query service
      |
      v
Workload repository
      |
      v
SQLite
```

Example repository operation:

```text
WorkloadRepository.searchInLatestReports(query, limit)
```

This keeps the MCP contract separate from the physical database schema and makes later migration easier.

---

## 10. Search Behavior

For the MVP, workload resolution uses simple deterministic matching.

Search order:

1. exact case-insensitive workload name match;
2. case-insensitive prefix match;
3. case-insensitive substring match.

Exact matches should appear before partial matches.

No LLM, embeddings, fuzzy search, or semantic index is required.

Potential searchable fields for the initial implementation:

- workload name.

Optional fields, only when already easy to support:

- namespace;
- Helm release name;
- chart name;
- application label.

---

## 11. Response Design Requirements

Responses must be:

- structured JSON;
- compact enough for an LLM context;
- based only on persisted analyzer output;
- explicit about missing values;
- explicit about snapshot time;
- stable across minor database schema changes.

The server should return normalized domain fields rather than raw database rows.

Avoid returning:

- full Kubernetes manifests;
- large unbounded finding payloads;
- internal SQL column names;
- secrets;
- registry credentials;
- arbitrary serialized analyzer internals.

---

## 12. Error Cases

The tool should handle:

### No matches

```json
{
  "query": "memelord",
  "matches": []
}
```

### Multiple matches

Return all bounded matches with enough context to distinguish them:

- cluster;
- namespace;
- workload kind;
- report timestamp;
- observed version.

### No completed reports

Return a clear structured error:

```json
{
  "error": {
    "code": "NO_COMPLETED_REPORTS",
    "message": "No completed Driftmower reports are available."
  }
}
```

### Stale snapshot

The MCP server does not need to decide whether a snapshot is too old, but it must expose its timestamp.

Optionally, it may include:

```json
{
  "snapshotAgeSeconds": 21600
}
```

### Missing analytical fields

Missing data should be represented as `null` or omitted according to a documented response convention.

The server must not invent versions, severities, statuses, or recommendations.

---

## 13. Out of Scope

The MVP does not include:

- direct Kubernetes API access;
- `kubectl` execution;
- Helm CLI execution;
- live cluster status;
- cluster mutations;
- manifest editing;
- Terraform parsing;
- Helm values parsing;
- Git operations;
- pull request creation;
- report generation;
- triggering a new analysis;
- recalculating latest versions;
- arbitrary SQL queries;
- natural-language-to-SQL;
- semantic or vector search;
- authentication or authorization for local `stdio` use;
- remote multi-user deployment;
- compatibility or upgrade safety guarantees;
- automatic rollback;
- validation that a target version is operationally safe.

---

## 14. Suggested Implementation Configuration

Example configuration:

```yaml
database:
  path: /data/driftmower.sqlite
  readonly: true

search:
  defaultLimit: 20
  maximumLimit: 100

reports:
  statusForSearch: completed

transport:
  type: stdio
```

Possible CLI:

```text
driftmower-mcp --db /data/driftmower.sqlite
```

Example IDE MCP configuration:

```json
{
  "mcpServers": {
    "driftmower": {
      "command": "driftmower-mcp",
      "args": [
        "--db",
        "/data/driftmower.sqlite"
      ]
    }
  }
}
```

---

## 15. Acceptance Criteria

The MVP is complete when:

1. The MCP server starts with a configured SQLite database path.
2. The database is opened in read-only mode.
3. The server exposes `search_workloads`.
4. Searching for `memelord` performs a case-insensitive substring search.
5. Only workloads from the latest completed report per cluster are searched.
6. Several matching workloads can be returned.
7. Results include cluster, namespace, kind, observed version, latest known version, and report timestamp where available.
8. The tool returns an empty match list when nothing is found.
9. The tool never modifies the database.
10. A coding agent can use the response to locate and update the relevant configuration in an open repository.
11. The MCP response clearly represents analyzed snapshot data rather than guaranteed live state.

---

## 16. MVP Value Proposition

The MCP server gives coding agents access to organization-specific infrastructure analysis that cannot be obtained cheaply from the open repository or from `kubectl` alone.

It connects three separate contexts:

```text
Driftmower:
interpreted infrastructure analysis

Live infrastructure tools:
current runtime state

IDE:
desired-state configuration and file editing
```

The initial MVP proves one complete and useful workflow:

```text
Ask about a workload
        |
        v
Retrieve Driftmower analysis
        |
        v
Understand deployed versus latest known versions and findings
        |
        v
Update the open infrastructure configuration
```
