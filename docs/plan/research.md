# Research notes: verified facts, corrections and open questions

Checked against Microsoft Learn on 2026-09-24. Where this document and the rest of the plan disagree, this document wins; fix the plan.

## 1. Verified facts the design depends on

### Plug-in trace log (`plugintracelog`)

| Fact | Consequence for the design | Source |
|---|---|---|
| `PluginTraceLogSetting` on `organization`: 0 = Off, 1 = Exceptions, 2 = All. | Read it on connect. Show a banner when it's Off. Watch mode can offer to switch it to All. | [Logging and tracing][lt] |
| **A bulk-delete job runs once a day and deletes records older than 24 hours.** Admins can disable the job or change how often it runs. | Confirmed. Records live for roughly 24 to 48 hours. Local history is a core feature, and the app has to sync at least once a day to avoid gaps. | [Logging and tracing][lt] |
| **`messageblock`, `configuration` and `secureconfiguration` return `null` unless the caller has the System Administrator role** (assigned directly or through a team). The other columns follow normal table privileges. | **New constraint that wasn't in the brief.** Users without System Administrator can see *that* a plugin ran, how long it took and its exception, but not its trace text. That affects the explorer, full-text search and the NuGet helper (§8 of features), which writes into the trace text. The app has to detect this and explain it. | [Logging and tracing][lt] |
| `messageblock` holds at most 10 KB. When it overflows, the **oldest** lines are dropped. | The explorer shows a "truncated" badge when a block is near 10 KB. The NuGet helper must write its structured header **last** (in `finally`), not first. | [Logging and tracing][lt] |
| Trace log rows **survive a transaction rollback**. | A failed sync save still leaves traces for steps that ran before the failure, so the timeline can show a pipeline that rolled back. | [Logging and tracing][lt] |
| Microsoft may turn off trace logging if `plugintracelogbase` grows past 100 GB. | Warn users against leaving the setting on All in busy environments. | [Logging and tracing][lt] |
| Columns: `correlationid`, `requestid`, `depth`, `mode` (0 Sync / 1 Async), `operationtype` (0 Unknown / 1 Plug-in / 2 Workflow Activity), `messagename`, `primaryentity` (string, **no record ID**), `typename`, `pluginstepid`, `performanceexecutionstarttime`, `performanceexecutionduration` (ms), `performanceconstructorstarttime`, `performanceconstructorduration` (ms), `messageblock`, `exceptiondetails`, `configuration`, `secureconfiguration`, `persistencekey`, `profile`, `issystemcreated`, `createdon`, `createdby`. | Matches the brief. Also available: `performanceconstructorstarttime` and `persistencekey`, which is set on async workflow rows. | [PluginTraceLog reference][ptl] |

### System jobs (`asyncoperation`)

| Fact | Consequence |
|---|---|
| `correlationid`, `requestid`, `depth`, `regardingobjectid` + `regardingobjecttypecode`, `owningextensionid` (→ `sdkmessageprocessingstep`), `workflowactivationid` (→ `workflow`), `operationtype` (1 System Event, 10 Workflow, …), `statecode`/`statuscode` (30 Succeeded, 31 Failed, 32 Canceled, …), `createdon`, `startedon`, `completedon`, `executiontimespan`, `message`, `friendlymessage`, `errorcode`, `retrycount`, `postponeuntil`, `messagename`, `primaryentitytype`, `parentpluginexecutionid`. | `regardingobjectid` gives an **exact** correlation-to-record link for anything that went async. `owningextensionid` gives an exact job-to-step link. `createdon`→`startedon` is queue time; `startedon`→`completedon` is run time. Source: [AsyncOperation reference][ao] |
| Async steps can have `asyncautodelete = true`, so the job is deleted when it succeeds. | Successful async jobs may not exist at all. The async *trace log* row still exists, so the timeline falls back to it. |

### Plugin registration

| Fact | Source |
|---|---|
| `sdkmessageprocessingstep`: `stage` (10 Pre-validation, 20 Pre-operation, 40 Post-operation; other values are internal), `mode` (0 Sync / 1 Async), `rank`, `filteringattributes`, `statecode` (Enabled/Disabled), `invocationsource` (Parent/Child), `impersonatinguserid`, `asyncautodelete`, `canbebypassed`, `sdkmessagefilterid`, `sdkmessageid`, `eventhandler` (plugintype or serviceendpoint), `ismanaged`, `solutionid`. | [SdkMessageProcessingStep reference][step] |
| `plugintypestatistic`: per plugin type `executecount`, `failurecount`, `failurepercent`, `crashcount`, `averageexecutetimeinmilliseconds`, and CPU/memory/handle termination percentages. **It's filled even when trace logging is off.** The time window it covers isn't documented. | [PluginTypeStatistic reference][pts] |

### Cloud flows

| Fact | Consequence | Source |
|---|---|---|
| `flowrun` is an **elastic** table. **It's user-owned**, and each run is assigned to the flow's primary owner. | **New constraint.** A user sees only runs they have read privilege for. Without org-level read on `flowrun`, other people's flows are invisible. The app has to say so. | [FlowRun reference][fr], [Cloud flow run metadata][cfrm] |
| Columns: `name` (run ID), `starttime`, `endtime`, `duration` (ms, bigint), `status` (string: Success/Failed/Cancelled), `triggertype` (string: Automated/Scheduled/Manual), `errorcode`, `errormessage`, `workflow` (lookup) / `workflowid` (string), `parentrunid`, `isprimary`, `modernflowtype`, `ttlinseconds`, `partitionid`. **There is no trigger record ID and no correlation ID.** | Flow-to-record links are inferred (see the correlation rules). `parentrunid` gives exact child-flow links. | [FlowRun reference][fr] |
| Only solution-aware flows are recorded. The default retention is 28 days (`FlowRunTimeToLiveInSeconds`); 0 turns ingestion off. The ingestion stream "isn't 100 percent lossless". `flowevent` rows with `EventType = FlowRunIngestion` indicate *some* known gaps. Runs can be throttled or skipped for high-volume owners. | Treat flow data as incomplete. Show `flowevent` gap signals. Never claim that a flow didn't run just because no `flowrun` row exists. | [Cloud flow run metadata][cfrm] |
| Elastic tables don't support filters on related tables, ordering on lookup columns, or several aggregate patterns (group by with order by, and more). | Query `flowrun` flat, filtered on `starttime` and `workflowid`, and aggregate on the client. | [Elastic tables][et] |
| `callbackregistration`: `entityname`, `message` (1 Added, 2 Deleted, 3 Modified, 4 Added or Modified, 5 Added or Deleted, 6 Modified or Deleted, 7 all three), `filteringattributes`, `filterexpression` (OData `$filter`), `scope` (1 User … 4 Organization), `runas`, `postponeuntil`, `sdkmessagename`, `softdeletestatus`, `name`. **There's no documented column that links a subscription to its `workflow`.** `url` can't be read. | Use the flow definition (`workflow.clientdata`, trigger JSON) as the main source for "which flows should fire". Use `callbackregistration` to check that the subscription is live. See spike S3. | [CallbackRegistration reference][cbr] |

### Audit

| Fact | Source |
|---|---|
| `audit` rows: `objectid`, `objecttypecode`, `operation` (1 Create, 2 Update, 3 Delete, 4 Access), `action`, `userid`, `callinguserid`, **`transactionid`**, `createdon`. **Since July 2025 `createdon` has millisecond precision.** `changedata` isn't available through the Web API; use `RetrieveRecordChangeHistory` / `RetrieveAuditDetails` to get old and new values. | [Retrieve audit data][aud] |
| Reading audit data needs `prvReadAuditSummary`. The change-history messages also need `prvReadRecordAuditHistory`. A query can join at most one `systemuser` link and no other tables. | [Retrieve audit data][aud] |

### Platform and API

| Fact | Source |
|---|---|
| **HTML web resources** are served from the environment's own origin and "can only be accessed using the Dataverse web application security context", so the page can call the Web API with the user's existing session and **needs no app registration**. The size limit per web resource is `Organization.MaxUploadFileSize` (default 5 MB). Web resources should reference each other by **relative** paths. Supported types include HTML, JS, CSS, PNG, SVG and RESX, but not fonts or JSON. **This is the chosen way to connect.** | [Web resources][wr] |
| **Power Apps Code Apps** (React + Vite in the Power Apps runtime) went GA in February 2026, but users need a **Power Apps Premium** licence. Rejected for a free tool. | [Code Apps guide (third-party)][ca] |
| (For reference: not used unless a standalone hosted mode is added.) A browser SPA can call the Dataverse Web API directly (CORS is enabled) with MSAL.js, using the auth code flow with PKCE, the SPA redirect platform and the delegated `user_impersonation` permission on Dataverse (`00000007-0000-0000-c000-000000000000`). The scope is `https://<org>.crm*.dynamics.com/.default`. **MSAL Browser v5 needs a redirect-bridge page** (`@azure/msal-browser/redirect-bridge`). | [SPA quickstart][spa] |
| Service protection limits, **per user, per web server**, over a 5-minute sliding window: 6,000 requests, 20 minutes of combined execution time, 52+ concurrent requests. A throttled request gets `429` with a `Retry-After` header. | [API limits][lim] |
| Multi-tenant apps from **unverified publishers** registered after November 2020: with risk-based step-up consent turned on, users can't consent to them for permissions beyond basic profile access. Publisher verification needs a Microsoft AI Cloud Partner Program account and a publisher domain that isn't `*.onmicrosoft.com`. | [Publisher verification][pv] |

### Competition

| Fact | Source |
|---|---|
| Microsoft's Dataverse accelerator **plug-in monitoring is "deprioritized and won't be delivered"**, along with the accelerator itself and the API playground. | [Plug-in monitoring (preview)][pm] |
| Plugin Trace Viewer (XrmToolBox, Jonas Rapp) already has: auto-refresh, multi-select filters (plugin, message, entity), grouping and filtering by correlation ID, a **"related executions" view (chronological, indented by depth, with durations and failures)**, statistics from the platform's plugin statistics, and Excel export. It's actively maintained (NuGet 1.2026.1.1). | [PTV site][ptv], [XrmToolBox listing][xtb] |
| VS Code "Dataverse Tools: Trace Viewer": search and filter by plugin, message, entity, correlation and date, exceptions-only toggle, expandable details, **up to 5,000 rows per query**, side-by-side panels. | [Marketplace][vsc] |

**Positioning takeaway:** PTV already does a plugin-only correlation view, so "we group by correlation ID" is **not** a differentiator. What sets Dataverse Trace apart is: (1) **several sources** (plugins, system jobs, flows, audit) on one waterfall, with inferred links shown honestly; (2) **expected vs. actual**; (3) **history and trends** beyond 24 hours; (4) **watch mode**; (5) **shareable sessions and OTLP export**; (6) runs anywhere without installing anything, including a demo.

## 2a. Spike results so far

Run 1 of the S6 diagnostics page (v0.0.1), in the maintainer's dev environment on 2026-09-24, Edge 151:

| Spike | Result |
|---|---|
| **S6 hosting** | ✅ **Confirmed.** Opened at `/WebResources/dvt_/spike/index.html`, the page and a **module worker** both call the Web API with the existing session (`WhoAmI` works in both). Dynamic `import()` chunks, IndexedDB, Web Locks, `CompressionStream` and `BroadcastChannel` all work in the page and in the worker. Storage quota is about 10 GB, not persisted by default. |
| S6 details | JS web resources are served as **`text/jscript`**, which is a valid JavaScript MIME type, so modules and workers load. **No CSP and no `X-Frame-Options` header** on web-resource pages; `cache-control: private`. `Organization.MaxUploadFileSize` = 5,242,880 (the default). Still to check: the versioned `/%7B…%7D/` path (a check was added in v0.0.2). |
| **S1 precision** | ⚠️ **The Web API returns whole seconds** for `asyncoperation` (`createdon`, `startedon`, `completedon`) and `flowrun` (`createdon`, `starttime`, `endtime`): all 25 sampled values had no fraction. Trace-log timestamps are still untested (tracing was Off). v0.0.2 adds a filter-bisection probe to see whether milliseconds are **stored** but not returned. |
| **S4 (partial)** | `flowrun` rows were written **about 30 s to 5 min after the run ended**. Watch mode must show flows as "waiting for run data". This user could read `flowrun` rows. |
| S2, S5, audit | Not tested yet: plug-in tracing was **Off** and auditing was **off** in this environment. The test plugins in `dotnet/TestPlugins` provide sync, async, nested and failing executions for the next run. |

**Design consequences already applied in v0.1** (whole-second timestamps are assumed until S1 shows otherwise):
- Sibling order inside a pipeline comes from **stage and execution order**, and positions within a second are laid out one after another and marked as *estimated*. Durations (from the platform, in ms) are shown as exact.
- System-job durations under a second are shown as "< 1 s", and a job is stretched to cover the activity it ran.
- Nesting (R3) uses a feasibility test instead of plain time containment. With a ±1 s tolerance, a short sibling step would otherwise "contain" a nested request. See architecture §7 for the rule and its measured accuracy.
- An assumption was tested and dropped: that trace rows are written in completion order (so `createdon` could order nested steps). When the platform writes them isn't documented, so R3 doesn't use it.

## 2. Things not yet verified: spikes before building on them

| # | Question | Why it matters | How to check |
|---|---|---|---|
| S1 | **What timestamp precision does the Web API return** for `performanceexecutionstarttime`, `createdon`, `startedon` and `starttime`? Seconds or milliseconds? | With whole seconds, sibling spans can't be ordered by start time, and the waterfall has to rely on depth, stage, rank and duration to lay spans out. | Query a dev environment with and without `Prefer: odata.include-annotations`. Compare with FetchXML results. |
| S2 | What does `plugintracelog.createdby` hold: the initiating user, the step's impersonated user, or SYSTEM? | Matching sync-only traces to a user's save (from audit `userid`) depends on it. | Run a step with and without impersonation and compare. |
| S3 | How do you map `callbackregistration` → `workflow`? Is `name` the workflow ID or the subscription? Is the trigger JSON in `workflow.clientdata` stable (entity, message, filtering attributes, filter expression, scope)? | Needed for flows in "expected vs. actual" and for scoring inferred flow links. | Create three test flows with different trigger settings and compare the rows. |
| S4 | How long after a run finishes does its `flowrun` row appear? Does a user with only default roles see runs of flows owned by others? | Needed to know whether watch mode can show flows live, and for the permission guidance. | Timestamp test and a second test user. |
| S5 | Does an async step's trace log `correlationid` equal its `asyncoperation.correlationid`? What do `depth` values look like across the async boundary? | This is the exact rule R1. | Register an async step and compare. |
| S6 | Does the bundle run as web resources: a web worker loaded from a web resource URL (and does its `fetch` carry the session?), IndexedDB and Web Locks on the environment origin, relative dynamic imports under the versioned `/%7B…%7D/WebResources/` path, and the platform CSP? | This is the whole connection model. | A "hello" solution that calls `WhoAmI` from the page and from a worker and writes to IndexedDB. Fallback if workers can't use the session: pass requests from the worker to the main thread. |
| S7 | Which import format does the current Jaeger UI accept (Jaeger JSON or OTLP/JSON)? | Decides the export format for the "open in Jaeger" story. | Load a sample file into Jaeger v2's all-in-one image. |
| S8 | What time window does `plugintypestatistic` cover (rolling? since registration?) and how often is it refreshed? | Decides whether snapshot differences can be read as trends. | Take snapshots every hour for two days. |
| S9 | Do Dataverse writes made by a cloud flow carry the flow run's identity (a correlation ID or caller), or do they start new correlation IDs? | Decides whether "flow → downstream plugins" can ever be an exact link. | Build a flow that updates a record with a traced plugin on it. |

[lt]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/logging-tracing
[ptl]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/plugintracelog
[ao]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/asyncoperation
[step]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/sdkmessageprocessingstep
[pts]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/plugintypestatistic
[fr]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/flowrun
[cfrm]: https://learn.microsoft.com/en-us/power-automate/dataverse/cloud-flow-run-metadata
[et]: https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-edit-elastic-tables
[cbr]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/callbackregistration
[aud]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/auditing/retrieve-audit-data
[spa]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/quick-start-js-spa
[lim]: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/api-limits
[pv]: https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
[wr]: https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/web-resources
[ca]: https://thepowertimes.com/posts/2026-02-18-power-apps-code-apps-getting-started-complete-guide/
[pm]: https://learn.microsoft.com/en-us/power-apps/maker/data-platform/dataverse-accelerator/plugin-monitoring
[ptv]: https://jonasr.app/ptv/
[xtb]: https://www.xrmtoolbox.com/plugins/Cinteros.XrmToolBox.PluginTraceViewer/
[vsc]: https://marketplace.visualstudio.com/items?itemName=gdhillon.dataverse-plugin-trace-viewer
