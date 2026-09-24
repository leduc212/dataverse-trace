# Features and key screens

Priorities: **P0** = v0.1 (MVP), **P1** = v0.2 to v0.3, **P2** = v1.0, **P3** = later or maybe.
See [the roadmap in PLAN.md](../PLAN.md#roadmap) for which milestone ships what.

Four principles apply to every feature:

1. **Read-only by default.** The only write the app can ever make is the optional trace-setting switch in watch mode. It always asks first and always puts the old value back. No deleting logs, no changing steps.
2. **Honest about inference.** Every link that isn't exact shows a confidence level and a "why" list of evidence. Missing data ("tracing was off", "no permission", "sync gap") is shown in the UI, never hidden.
3. **Works without Dataverse.** Every screen works in demo mode and on imported sessions.
4. **Keyboard first.** Every main action has a shortcut, and a command palette (Ctrl+K) reaches all of them.

---

## 1. Connection and sync (P0)

- **No sign-in step.** The app is installed as a solution and opened inside the environment, so it's already connected to that environment with the user's session. Each environment has its own install and its own local store (IndexedDB is per origin). The demo site has no connection at all.
- **Capability probe on connect.** Checks and shows: the trace-log setting (Off/Exceptions/All); whether trace text is readable (System Administrator); read access to `asyncoperation`, `flowrun`, `audit` and `workflow`; audit enabled on the organization; flow-run TTL; `flowevent` gap signals. Anything missing is explained, with the privilege needed to fix it.
- **Background sync.** Pulls new rows incrementally into IndexedDB (see [architecture §5](architecture.md#5-sync-engine)). A status chip shows the last sync, rows per source, requests used in the throttling window, and **coverage gaps** ("no data 03:00–09:12, the app was closed for more than 24 hours").
- **First connect catch-up.** Pulls everything still on the server (about 24 to 48 hours of traces, up to 28 days of flow runs, 7 days of system jobs by default), with a progress bar and a cancel button.

## 2. Log explorer (P0): "excellent at the basics"

Aims to match Plugin Trace Viewer feature-for-feature on reading logs, and to beat it on speed, search and readability.

| Capability | Detail |
|---|---|
| Virtualised grid | Smooth with 100k+ rows. Columns can be chosen, reordered and resized. Duration shown as an inline bar. Error rows tinted. Sticky group headers. |
| Filters | Time range (relative presets, absolute range, or brush-select on the histogram above the grid), with facets and counts for type name, step, message, table, mode, depth, operation type and status. Also a duration range, and correlation or request ID (paste a GUID from anywhere, including an error dialog's log file). |
| Query bar | Filter text such as `table:account msg:Update dur>2000 err "NullReference"`, with autocomplete. Filters are two-way synced with the facet UI and the URL, so views can be bookmarked and shared (the URL holds filter state only, never data). |
| Full-text search | Over trace text and exceptions, with an index built in a web worker. Matches are highlighted in the grid and the detail pane. |
| Grouping | By correlation ID (the default "operations" view: one row per operation that expands to its spans), step, type, table, or none. |
| Live tail | Polls every 5 s when on. A "12 new rows" pill appears instead of jumping the scroll position. |
| Detail pane | **Trace** tab: CodeMirror read-only viewer with line numbers, find-in-trace (Ctrl+F), GUID and timestamp highlighting, embedded JSON/XML pretty-printed and folded, and a *truncated at 10 KB* badge. **Exception** tab: a parsed .NET exception (type, message, inner-exception chain, stack frames with user code highlighted and framework frames folded) and a "copy as Markdown" button. **Registration** tab: step stage, rank, filtering attributes, images, assembly and version, managed or unmanaged. **Related** tab: other spans with the same correlation ID, plus "Open in timeline". **Raw** tab: the JSON row. |
| Deep links | Open the step in the classic step form (`main.aspx?etn=sdkmessageprocessingstep&id=…`). Open the record when it's known (from system-job `regardingobjectid`, the helper header, or watch mode). Every row, view and trace also has an in-app link. |
| Saved views | Named filter, column and grouping presets, stored per environment. |
| Export | The selection or the filtered set as CSV or JSON. |
| Missing trace text | When `messageblock` is null because the user isn't System Administrator, show an explanation instead of an empty pane. |

## 3. Timeline, the waterfall (P0 for exact links; P1 adds inferred links)

One trace means **everything that ran for one correlation ID**, or (in P1) **for one record save**, which can span several correlation IDs.

- **Lanes:** *Sync pipeline* (in the transaction, nested by depth, split into stages 10/20/main/40), *Async* (system jobs and async plugins), *Flows*, and *Audit*, where changes show as diamond markers with the changed columns.
- **Bars:** queue time (created→started) is drawn hatched and run time solid. Errors get a red end-cap. Constructor time is a thin sub-segment. Running jobs have an animated open end.
- **Links:** exact parent-child links are drawn as solid connectors. **Inferred links are dashed and carry a confidence badge** (e.g. `72%`). Clicking the badge opens the evidence list (e.g. "trigger table matches +0.3, started 1.8 s after commit +0.35, 2 other saves on this table in the window −0.2").
- **Tools:** zoom and pan (wheel and brush), a minimap, "collapse to depth N", a critical-path highlight (the longest dependent chain), a toggle for "show inferred links below X%", and a **precision indicator** when source timestamps only have whole-second precision (spike S1).
- **Accessibility:** the same data is available as an indented table view (screen readers, and copy as Markdown).
- **Summary header:** total wall time, time inside the transaction, counts by kind, errors, max depth, and gaps and caveats.

## 4. Dashboard (P0 basics, P1 trends and insights)

- **KPI tiles** for the chosen range: executions, error rate, p95 sync duration, slowest step, max depth, data coverage %.
- **Per-step table:** count, errors, error %, p50/p95/max duration, average constructor time, a sparkline, and the change against the previous period. Sortable. Clicking a row opens the explorer filtered to that step.
- **Top lists:** slowest steps (by p95), most failing steps, noisiest steps (by volume).
- **Heatmap:** executions by hour of day × date, or × day of week, with volume or errors as the colour.
- **Duration distribution** for a selected step: histogram and box plot, comparable across two periods.
- **Trends (P1):** daily or hourly lines built from local history, with **coverage bands** that shade periods where no data was collected, so a gap doesn't look like a drop.
- **Platform stats panel (P1):** `plugintypestatistic` values (execute and failure counts, average time, crash and termination %). It works **even when tracing is Off**. Snapshots are stored on every sync so they can be trended once spike S8 confirms the semantics.
- **Insights (P1):** rule-based findings, each with a severity, the evidence and a link to the data behind it. First rule set:

| Rule | Trigger (defaults can be changed) |
|---|---|
| Update step without filtering attributes | Step on `Update` with empty `filteringattributes` and more than 100 runs a day |
| Possible loop | Depth ≥ 6 in any trace, or the same step appears more than once in one correlation |
| Slow sync step | Sync step p95 > 2,000 ms (it blocks the user's save) |
| Heavy constructor | Constructor time > 20 % of execution time, or > 100 ms p95 |
| Error spike | Error rate in the last 24 h > 3× the 7-day baseline, with at least 10 errors |
| Retry storm | Async jobs with `retrycount` > 0, or more than 50 jobs *Waiting* for one step |
| Truncated traces | More than 10 % of a step's trace blocks are near 10 KB |
| Tracing off | `PluginTraceLogSetting` = Off (dashboard is limited to platform stats) |
| Flow data incomplete | `flowevent` has ingestion-gap signals in the range |
| Sync gap | Local history has gaps longer than 24 h in the range |

## 5. Expected vs. actual (P1)

Input: **table + message + changed columns** (typed in, taken from audit, or captured in watch mode), plus an optional record for evaluating flow filter expressions.
Output: an ordered list of everything registered to run, each item marked with whether it **fired**:

- Plugin steps by stage then rank (pre-validation, pre-operation, post-operation), then async steps. Filtering-attribute matching is evaluated against the changed columns.
- Classic workflows (`workflow` category 0): real-time or background, trigger on create or on update of certain columns, scope.
- Business rules (category 2) with entity scope, listed as "runs server-side" when scope = Entity.
- Cloud flows (category 5, solution-aware): trigger parsed from `clientdata` (table, change type, filtering columns, filter expression, scope). Checked against `callbackregistration` to confirm a live subscription.
- **Why-not explanations**, for example: step disabled, filtering attributes {name, phone} don't overlap the changed set {statuscode}, message mismatch, `invocationsource` = Child only, flow turned off, filter expression evaluated false (for the supported OData subset) or can't be evaluated, flow has trigger conditions (not evaluated; shown as a warning), and not seen because tracing was set to Exceptions only.
- Status per item: ✓ fired (linked span) · ✗ didn't fire (reason) · ? unknown (no evidence either way, e.g. flow data may be incomplete).

## 6. Watch mode (P1)

1. Pick a record: paste a model-driven app URL (the app reads `etn` and `id` from it), search by primary name, or pick one from recent system jobs.
2. The **expected list** for that table is precomputed and shown as ghost bars.
3. Press **Watch** (a countdown starts) and do the action in the app.
4. The app polls every 2 s for new rows only: trace logs after the start time, system jobs whose regarding record is the watched one or whose correlation ID has already been seen, flow runs of candidate flows, and audit for the record. The timeline fills in live, and ghost bars turn into real bars or are marked "not seen".
5. Stop manually, or automatically after 60 s of no new rows. The session is saved and can be exported.

**Optional "trace everything for this session":** if the setting isn't All, offer to switch it for the session. The consent dialog shows the current value, the environment name and "we'll restore *Exceptions* when you stop". Restore happens on Stop, on tab close (best effort) and **on the next app start**, because a *pending-restore* marker is kept in IndexedDB. Only offered to System Administrators, and a warning is shown when the environment looks like production (the environment type is shown when it can be detected, P2).

## 7. Loop and cascade graph (P1)

- **Observed graph:** nodes are steps, flows and workflows; an edge A→B means B ran at depth d+1 inside A's execution. Edge labels show counts and p95 duration. **Cycles are highlighted**, and clicking one opens example traces.
- **Static risk graph (P2):** built from registrations. A flow triggered on table X whose actions update table X (parsed from `clientdata` actions), or an Update step on X without filtering attributes, is flagged as "potential loop".
- Layout with ELK. The range can be filtered by table or assembly.

## 8. Sharing (P1 JSON; P2 OTLP)

- **Session export** to a `.dvtrace.json` file (versioned schema, optionally gzipped). It contains the spans, links and evidence of a trace or watch session, plus the registration context.
- **Redaction on export:** masks the trace text (entirely, or by regex for emails, GUIDs and numbers), record IDs and user names, with a preview before saving.
- **Import:** drag and drop a file onto the app. It opens read-only **without signing in**, so a teammate or a support engineer can look at a bug report without access to the environment.
- **Copy as Markdown:** a short summary table (span, duration, status, error) for pasting into a work item.
- **OTLP/JSON export (P2):** each span maps to an OpenTelemetry span (trace ID from the correlation ID, attributes under a `dataverse.*` namespace, inferred links as span links with `dataverse.link.confidence`). Import into Jaeger is documented (spike S7), as is sending it to App Insights through an OpenTelemetry Collector.

## 9. Compare two traces (P2)

Pick two traces of the same operation (e.g. before and after a deployment). Spans are aligned by step, and the view shows the added, missing and slower spans with their deltas. It answers "why is save slower since Tuesday?".

## 10. NuGet trace helper (P2)

A **source-only** NuGet package (a `.cs` content file, so plugin assemblies don't take on a dependency and no ILMerge or plugin package is needed):

```csharp
using var dvt = DataverseTrace.Begin(context, tracingService);   // header written on Dispose
dvt.Mark("Loaded config");                                        // sub-span timing
dvt.Mark("Called ERP");
```

It writes one line **at the end** (so it survives truncation, which drops the oldest lines):
`#dvt {"v":1,"rec":"account:3f2…","msg":"Update","attrs":["name","telephone1"],"init":"<userid>","marks":[["Loaded config",12],["Called ERP",840]]}`

This makes the record link **exact** (confidence 1.0) and adds **sub-spans inside a plugin** to the waterfall. Documented limitation: trace text is readable only by System Administrators, so other users don't get the benefit.

## 11. Demo mode (P0)

- A **scenario-based generator** with a fixed seed (see [architecture §9](architecture.md#9-demo-mode)) for a fictional company, "Harbor Insurance". About two weeks of history (~60k plugin executions), and scripted scenarios that each show off one feature:
  1. A normal policy save: 6 sync steps, 2 async steps, 1 flow (inferred link at 87 %).
  2. A **recursive update loop** that reaches depth 8.
  3. A **slow sync plugin**: an ERP call with p95 of 3.4 s, slowing down after a "deployment" on day 9.
  4. An async job that fails and retries 3 times.
  5. An Update step **without filtering attributes** that ran 400 times today.
  6. An **expected-vs-actual miss**: a flow didn't fire because the changed column isn't in its filtering columns.
  7. A **low-confidence flow link** (three saves of the same table within 2 s).
- A **guided tour** (5 steps) on first visit, which can be dismissed. A "Try demo" button on the landing page, no sign-in needed.
- Watch mode has a **simulated** run: press Watch, then "Simulate save", and the spans stream in.

## 12. Later (P3)

Desktop build with a system-tray background collector (Tauri), an XrmToolBox shell (WebView2 hosting the same bundle), a standalone hosted mode with MSAL for many environments on one site (needs an app registration), sovereign clouds, and an optional **team collector**: a scheduled job that copies trace rows to durable storage so history doesn't depend on someone's browser being open.

---

## Key screens (wireframes)

### App shell

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ Dataverse Trace  [ harbor-dev ▾ ]   Explorer  Timeline  Dashboard  Registrations  ⌘K │
│                                       Watch                        ● Synced 12s ago  ⓘ │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  ⚠ Trace text hidden: your account isn't System Administrator.  [Why?]  [Dismiss]      │
```

### Explorer

```
┌─ Query ──────────────────────────────────────────────────────────────────────────────┐
│ table:account msg:Update dur>500 err                                   [Last 24h ▾]  │
├─ Histogram (drag to zoom) ───────────────────────────────────────────────────────────┤
│ ▁▁▂▃▅▇▅▃▂▁▁▁▁▂▂▃▃▅█▇▅▃▂▁   ■ ok  ■ error                                            │
├─ Facets ───────────┬─ Operations (grouped by correlation) ───────┬─ Detail ──────────┤
│ Type name       ▾  │ ▸ 09:41:12  Update account   7 spans  3.9s ✖│ Harbor.Plugins.   │
│ ☑ Harbor.Acc… 412  │ ▾ 09:40:58  Create policy   11 spans  1.2s  │  PolicyPostCreate │
│ ☐ Harbor.Pol… 188  │    d1 Pre  PolicyValidate         42ms ▏    │ [Trace][Exception]│
│ Message         ▾  │    d1 Post PolicyPostCreate      880ms ▇▇▇  │ [Registration]... │
│ ☑ Update     1.2k  │    d2 Post AccountRollup         120ms ▎    │  1 Start policy…  │
│ Depth           ▾  │    ⧗ async PolicyNotify   q 2.1s 310ms ▍    │  2 Loaded config  │
│ 1 ██████ 2 ███ 3 ▌ │ ▸ 09:40:31  Update contact   2 spans   88ms │  3 ▸ {json 14 ln} │
│ Duration  [──●───] │ …  virtualised: 48,211 rows                 │  Ctrl+F  find…    │
└────────────────────┴─────────────────────────────────────────────┴───────────────────┘
```

### Timeline

```
┌─ Save of policy HP-10442 · Update · 3 correlations · 4.8s wall · 1 error · depth 3 ──┐
│ Lanes         0s        1s        2s        3s        4s        5s    [precision: ms]│
│ ◇ Audit       ◆ name, premium changed (J. Ortiz)                                     │
│ Sync          ├─ Pre-val  PolicyValidate ▌                                           │
│  pipeline     ├─ Pre-op   PolicyDefaults ▍                                           │
│               ├─ Post-op  PolicyPostCreate ▇▇▇▇▇▇▇▇                                  │
│               │   └ d2    AccountRollup     ▇▇                                       │
│ Async         ├─ PolicyNotify         ░░░░░░░░░▇▇▇                (q 2.1s)           │
│               └─ ERP Sync             ░░░░░░░░░░░░░░▇▇▇▇▇▇▇✖  retry 1/3              │
│ Flows         ┄┄ Send welcome email   ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄▇▇▇▇▇▇▇▇▇  [87%] ← dashed      │
│ Minimap ▕▁▁▂▅▇▅▂▁▁▁▁▂▃▅▃▁▏      [Critical path] [Collapse to depth ▾] [Hide < 50%]  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Dashboard

```
┌ Range: Last 7 days ▾   Table: all ▾   Assembly: all ▾    Coverage 96% (gap Tue 02-07h)┐
│ ┌Executions┐ ┌Error rate┐ ┌p95 sync ┐ ┌Slowest step      ┐ ┌Max depth┐               │
│ │ 61,204   │ │ 1.8% ▲0.6│ │ 740ms ▲ │ │ ErpSync 3.4s p95 │ │ 8 ⚠     │               │
│ └──────────┘ └──────────┘ └─────────┘ └──────────────────┘ └─────────┘               │
│ ┌ Trend: executions / errors per hour ─────────────┐ ┌ Insights ─────────────────────┐│
│ │ ╱╲╱╲╱╲╱╲╱╲▒▒▒╱╲╱╲╱╲  (▒ = no data collected)     │ │ ⚠ AccountAudit: no filtering  ││
│ └──────────────────────────────────────────────────┘ │   attributes, 400 runs today  ││
│ ┌ Heatmap hour × day ──────┐ ┌ Steps ─────────────── │ ⛔ Depth 8 reached in 3 traces ││
│ │ Mon ░░▒▓█▓▒░░            │ │ Step        n   err p95 │ ⚠ ErpSync p95 3.4s (sync)    ││
│ │ Tue ░░▒▓█▓▒░░            │ │ ErpSync   2.1k 4% 3.4s ~│  [View evidence →]           ││
│ └──────────────────────────┘ └─────────────────────── └───────────────────────────────┘│
```

### Expected vs. actual

```
┌ account · Update · changed: [statuscode ×] [ownerid ×] [+ add]   Record: (optional) ──┐
│ Stage            # Registered item                    Filter match         Fired?     │
│ Pre-validation   1 Harbor.AccountValidate              any column           ✓ 38ms    │
│ Pre-operation    1 Harbor.AccountDefaults              name, phone ✗        ✗ filter  │
│                  2 BR: "Require industry" (entity)     n/a                  ? unknown │
│ Post-operation   1 Harbor.AccountRollup                ownerid ✓            ✓ 120ms   │
│ Async            1 Harbor.AccountNotify                any column           ✓ q2.1s   │
│ Flow             – "Account owner changed"             ownerid ✓ filter ✓   ✓ 87%     │
│ Flow             – "Notify VIP team"                   statuscode ✓ filter ✗ ✗ filter │
│                     filter: customertypecode eq 3 → record has 1                     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Watch mode

```
┌ Watch ───────────────────────────────────────────────────────────────────────────────┐
│ Record: [https://harbor.crm.dynamics.com/main.aspx?etn=account&id=3f2…  ] ✓ Contoso  │
│ Trace setting: Exceptions  ☐ Switch to "All" during this session (restored on stop)  │
│ [● Watching 00:14]  polling every 2s · 3 requests/2s · stop after 60s idle  [■ Stop] │
│ ── Live timeline ─────────────────────────────────────────────────────────────────── │
│ Sync   AccountValidate ▌  AccountRollup ▇▇                                           │
│ Async  AccountNotify  ░░░░▇                                                          │
│ Flows  ▫▫▫ Account owner changed (expected · waiting for run data…)                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
