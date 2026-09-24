# Requirements

Each requirement has an ID so tests and issues can refer to it. Priority P0–P3 follows [features.md](features.md).

## 1. Functional requirements

### Connection and access
| ID | Requirement | P |
|---|---|---|
| FR-C1 | Ship as a managed Dataverse solution (web resources plus a site-map entry). Opened inside an environment, the app uses the user's existing session. No separate sign-in, no app registration. | P0 |
| FR-C2 | Detect the host (in-environment, demo, and later XrmToolBox) and pick the matching transport. The environment URL comes from the page origin. | P0 |
| FR-C3 | On start, run a capability probe (see §3) and show the results. Features whose data can't be read show why and what privilege is missing. | P0 |
| FR-C4 | The demo site (GitHub Pages) works with no sign-in: demo scenarios and imported session files only. | P0 |
| FR-C5 | Optional standalone hosted mode with MSAL (bring your own client ID) for viewing several environments from one site. | P3 |

### Collection and history
| ID | Requirement | P |
|---|---|---|
| FR-H1 | Incremental sync of trace logs (metadata, then blobs), system jobs, flow runs, flow events, registrations and plugin-type statistics into local storage. | P0 (traces, jobs, registrations), P1 (flows, stats) |
| FR-H2 | Keep history beyond the server's retention period. Retention settings per data class. | P0 |
| FR-H3 | Record which time ranges were synced and show gaps in every time-based view. | P0 |
| FR-H4 | Handle throttling (`429` + `Retry-After`), resume after interruption, and let only one tab sync at a time. | P0 |
| FR-H5 | Fetch audit data on demand for a record or time window. | P1 |

### Explorer
| ID | Requirement | P |
|---|---|---|
| FR-E1 | Virtualised grid over all locally stored trace rows, with configurable columns, sorting and grouping (correlation / step / type / table / none). | P0 |
| FR-E2 | Filter by time, facets with counts, duration range, correlation or request ID, and errors only. A text query syntax with autocomplete. Filter state reflected in the URL. | P0 |
| FR-E3 | Full-text search over trace text and exception text, with highlighted matches. | P0 |
| FR-E4 | Detail pane with trace text (find-in-trace, JSON/XML pretty-printing, truncation badge), parsed exception, registration context, related spans, raw JSON. | P0 |
| FR-E5 | Live tail. Saved views. CSV/JSON export of the filtered set. | P0 |
| FR-E6 | Deep links to the step form, to the record when known, and to any row, view or trace in the app. | P0 |

### Timeline
| ID | Requirement | P |
|---|---|---|
| FR-T1 | Waterfall for a correlation ID, using the exact rules R1–R9. | P0 |
| FR-T2 | Waterfall for a record save, across several correlations, flows (I2) and audit, with inferred links drawn differently and showing confidence and evidence. | P1 |
| FR-T3 | Zoom, pan, minimap, collapse by depth, critical path, confidence threshold, timestamp-precision indicator, table view. | P0 (basic), P1 (all) |
| FR-T4 | Compare two traces. | P2 |

### Dashboard and insights
| ID | Requirement | P |
|---|---|---|
| FR-D1 | KPI tiles, per-step statistics (count, errors, p50/p95/max, constructor), top lists, heatmap, duration distribution. | P0 |
| FR-D2 | Trends over local history, with coverage bands. | P1 |
| FR-D3 | Platform statistics panel (`plugintypestatistic`) that works with tracing off. | P1 |
| FR-D4 | Insight rules (see features §4), with thresholds the user can change and evidence links. | P1 |

### Expected vs. actual, watch mode, graph, sharing
| ID | Requirement | P |
|---|---|---|
| FR-X1 | Given a table, a message and changed columns (and optionally a record), list the registered steps, workflows, business rules and flows in execution order, with fired / didn't fire / unknown and the reason. | P1 |
| FR-W1 | Watch a record: poll for new rows only, show expected ghost spans, fill the timeline live, stop automatically when idle, save the session. | P1 |
| FR-W2 | Optionally switch trace logging to All for the session. Explicit consent, restore on stop, on tab close (best effort), and on the next start. | P1 |
| FR-G1 | Observed cascade graph with cycle detection. | P1 |
| FR-G2 | Static loop-risk analysis from registrations and flow definitions. | P2 |
| FR-S1 | Export and import sessions as `.dvtrace.json`, with redaction options. Imported sessions open without signing in. | P1 |
| FR-S2 | Copy a trace summary as Markdown. | P1 |
| FR-S3 | OTLP/JSON export. | P2 |
| FR-N1 | Source-only NuGet helper; the parser recognises `#dvt` headers and marks. | P2 |

### Demo
| ID | Requirement | P |
|---|---|---|
| FR-M1 | A "Try demo" option with no sign-in, covering every P0 and P1 screen with the scripted scenarios. | P0 (grows with each milestone) |
| FR-M2 | Guided tour. Simulated watch run. | P1 |

## 2. Non-functional requirements

### Performance
| ID | Target |
|---|---|
| NFR-P1 | Cold load of the explorer shell: < 2.5 s on a fast 4G profile. First visual in demo: < 2 s. Shell under about 250 KB gzipped. |
| NFR-P2 | Explorer with 100,000 rows: scrolling at 60 fps, and filter or sort in under 100 ms (in the worker). |
| NFR-P3 | Full-text search over 50,000 trace blocks: first query < 3 s (index build), then < 150 ms. |
| NFR-P4 | Timeline with 2,000 spans renders in < 300 ms, and interaction stays at 60 fps. |
| NFR-P5 | Dashboard over 90 days of rollups: < 500 ms. |
| NFR-P6 | Background sync uses at most about 5 % of the per-user service-protection budget. Watch mode uses at most 2 requests per second. |

### Security and privacy
| ID | Requirement |
|---|---|
| NFR-S1 | No backend. In the environment, requests are same-origin calls to that environment's Web API only. The demo site makes no data requests. No analytics or telemetry. |
| NFR-S2 | The app never handles credentials or tokens. It acts with the signed-in user's own privileges, and nothing more. |
| NFR-S3 | A strict CSP (see architecture §11). No third-party scripts, fonts or CDNs at runtime. |
| NFR-S4 | All trace, exception and imported content is shown as text. Imported files are validated against the schema. |
| NFR-S5 | Read-only by default. Any write (the trace setting) needs explicit consent each time, and its restore is guaranteed. |
| NFR-S6 | Redaction on export. "Forget environment" wipes all local data for that environment. |

### Reliability and correctness
| ID | Requirement |
|---|---|
| NFR-R1 | Correlation output doesn't depend on input order and has no cycles (property-tested). |
| NFR-R2 | Every inferred link shows its confidence and evidence. Nothing inferred is ever drawn as exact. |
| NFR-R3 | Sync can resume, doesn't store duplicates, and survives tab closes and 429s. |
| NFR-R4 | Local schema migrations are versioned and tested. An export or backup can be made before a destructive migration. |

### Usability and accessibility
| ID | Requirement |
|---|---|
| NFR-U1 | WCAG 2.2 AA. Everything works by keyboard. The waterfall has a table alternative. Palettes are safe for colour-blind users. Light and dark themes. |
| NFR-U2 | Times are shown in local time or UTC (a toggle), with ms precision where the source has it. |
| NFR-U3 | UI in English for v1. Strings are externalised so translations are possible later. |

### Maintainability
| ID | Requirement |
|---|---|
| NFR-M1 | `packages/core` has ≥ 90 % line coverage and no DOM or network dependencies. |
| NFR-M2 | Architecture decisions are recorded as ADRs in `docs/adr/`. |
| NFR-M3 | Strict TypeScript. No `any` in `core` or `dataverse`. |

## 3. Permissions needed (read by the capability probe)

| Data | Needed | Without it |
|---|---|---|
| **Install** | Import the solution: System Customizer or System Administrator, **once per environment**. Using it: any licensed user who has read access to the `dvt_` web resources (normal for any user who can open the model-driven app). | Use the demo site, or the XrmToolBox tool later. |
| Trace log rows | Read on `plugintracelog` (System Customizer and System Administrator have it) | No explorer or dashboard from traces; the platform-stats panel only. |
| **Trace text and configuration** | **System Administrator role** (direct or through a team) | Rows show without trace text; full-text search covers exceptions only; helper headers are invisible. |
| System jobs | Read on `asyncoperation` (org-level for all users' jobs) | Async lane shows only trace rows; no exact record anchors (R5). |
| Registrations | Read on `sdkmessageprocessingstep`, `sdkmessagefilter`, `sdkmessage`, `plugintype`, `pluginassembly`, `sdkmessageprocessingstepimage` | No registration context, no expected vs. actual for plugins. |
| Workflows, flows, business rules | Read on `workflow` (and `clientdata`) | No expected vs. actual for processes and flows. |
| Flow subscriptions | Read on `callbackregistration` | Flow triggers aren't cross-checked against live subscriptions. |
| Flow runs | Read on `flowrun`, **org level** to see flows owned by other people; plus `flowevent` | Flow lane is limited to the user's own flows, and a caveat is shown. |
| Audit | `prvReadAuditSummary` + `prvReadRecordAuditHistory`; auditing turned on for the org and table | No audit markers; record traces rely on system jobs, the helper or watch mode. |
| Plugin-type statistics | Read on `plugintypestatistic` | No platform-stats panel. |
| Organization settings | Read on `organization`; **write** (System Administrator) only for FR-W2 | Trace setting shown as "unknown"; no session switch. |

Recommended setup: **System Administrator on dev and test environments**. On other environments the app still works with degraded features and explains what's missing.

## 4. Supported environments

| Area | v1 support |
|---|---|
| Dataverse | Online, commercial cloud, Web API v9.2. Any environment type (developer, sandbox, production); **the tool is aimed at dev and test**. |
| Sovereign clouds (GCC, GCC High, DoD, China) | Not in v1. The authority and endpoints are configurable for later. |
| On-premises Dynamics 365 | Not supported (different auth; no `flowrun`). |
| Browsers | The last two versions of Edge, Chrome, Firefox and Safari. Needs IndexedDB, Web Workers, `CompressionStream` and Web Locks (with a fallback when Locks isn't available). |
| Screens | Built for desktop (≥ 1280 px). Read-only views still work on tablets. Phones aren't a target. |
