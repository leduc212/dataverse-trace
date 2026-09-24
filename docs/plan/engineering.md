# Tech stack, repo structure, tests and CI

## 1. Tech stack decisions

| Area | Choice | Why | Alternatives considered |
|---|---|---|---|
| App type | **Static SPA, no backend**, shipped as **Dataverse web resources** for real use and on **GitHub Pages** for the demo | No data passes through a server we run: that's the security and trust story. As web resources it uses the user's existing Dataverse session, so **there's no app registration and no token handling**. Hosting is free. | A hosted SPA with MSAL (needs an Entra app registration and consent); Power Apps Code Apps (needs Premium licences); Next.js with a server proxy (a server that sees tenant data); Electron-first (needs an install) |
| Language | **TypeScript (strict)** | One language across the domain logic, UI and tests. Types document the span model. | — |
| UI framework | **React 19** | The largest ecosystem for what this app needs (virtualised grids, React Flow, charts, CodeMirror bindings). Familiar to most reviewers. | Blazor WebAssembly (familiar to a .NET/Power Platform developer, but heavier to download, with fewer visualisation libraries and awkward web-worker support); Svelte/Solid (smaller ecosystem for data grids and graphs). |
| Build | **Vite** | Fast dev server, first-class worker bundling (`?worker`), library mode for packages. | webpack, Parcel |
| UI components | **Fluent UI React v9** (decided, D3) | Looks and feels like the Power Platform to its users, is accessible, has theme tokens for light and dark, and is used in PCF work. Griffel can pre-extract CSS for a strict CSP. | shadcn/ui + Tailwind (more distinctive visually, less "native" to Power Platform users) |
| Routing | **TanStack Router** | Typed search params, which suits URL-encoded filter state. | React Router |
| UI state | **Zustand** for UI state. Data comes from the worker through a small hook layer. | Small and explicit. Server state lives in the worker and IndexedDB, not in a client cache. | Redux Toolkit, TanStack Query (little fit: the "server" is the local worker) |
| Worker RPC | **Comlink** | Typed, promise-based calls into the worker with little code. | Hand-written postMessage |
| Local storage | **Dexie 4** over IndexedDB | Indexes on compound keys, transactions, `liveQuery`, a good migration story. `fake-indexeddb` for tests. | idb (lower level), SQLite WASM + OPFS (strong, but bigger and more complex; revisit if queries outgrow Dexie) |
| Auth | **None of our own.** Same-origin calls with the Dataverse session. | The web-resource host inherits the user's sign-in. | @azure/msal-browser (only if a standalone hosted mode is ever added) |
| Solution packaging | **Own Node packer** (`tools/solution-packer`, uses `fflate`) | Builds the solution zip (`solution.xml`, `customizations.xml`, web resources) straight from the Vite output, with stable web-resource IDs derived from names. Node only, so contributors and CI don't need .NET (the current `pac` needs .NET 10). Unit-tested. | Power Platform CLI `pac solution pack` (extra runtime dependency); manual export from a dev environment |
| Grid | **TanStack Table + TanStack Virtual** | Headless, so it fits Fluent styling; virtualisation handles 100k rows. | AG Grid Community (heavy; its Enterprise features are licensed), Fluent DataGrid (not built for 100k rows) |
| Charts | **Apache ECharts** (via a thin wrapper) | Canvas rendering for large data. Heatmap, box plot, histogram and brush-zoom built in. Dark theme. | Recharts (SVG, slows down with many points), visx (more code to write), Observable Plot (fewer interactions) |
| Waterfall | **Custom SVG component** | The core visual needs exact control (lanes, queue hatching, dashed inferred links, confidence badges, critical path). Span counts per trace are small enough for SVG with row virtualisation. | A charting library's Gantt (can't do the link semantics) |
| Graph | **React Flow (@xyflow/react) + elkjs** | Interactive nodes and edges; ELK gives readable layered layouts for cascades. | Cytoscape.js |
| Text viewer | **CodeMirror 6** (read-only) | Large documents, search panel, folding, custom highlighting for GUIDs, timestamps and stack frames. Much lighter than Monaco. | Monaco (about 2 MB) |
| Search | **MiniSearch** in the worker | Small, prefix and fuzzy search, index can be serialised. | FlexSearch (faster, but messier typings) |
| Validation | **zod** | Session file schema, settings, OData row parsing at the boundary. | valibot |
| Monorepo | **pnpm workspaces** | Strict dependency isolation, fast installs, no extra tooling. | npm workspaces, Nx, Turborepo (not needed at this size) |
| Lint and format | **ESLint (typescript-eslint strict) + Prettier** | Standard and familiar. | Biome (faster; fine to switch later) |
| Docs site | **Astro Starlight** | Good-looking docs with search, MDX, and interactive islands (an embedded mini-waterfall). | VitePress, Docusaurus |
| Hosting | **Dataverse web resources** (real use, from the solution zip on GitHub Releases) + **GitHub Pages** (demo and docs) | Both free. Pages is free for public repos, no extra account, deploys straight from GitHub Actions. The app is plain static files. CSP goes in a `<meta>` tag, which covers everything this app needs (`frame-ancestors` is the only directive it can't set, and that's low risk here). | Azure Static Web Apps Free (real headers and PR previews, but another account and service to manage; revisit only if needed) |
| Plugin helper | **C# source-only NuGet** (`contentFiles`) | No assembly dependency, so no ILMerge or plugin package for users. Targets .NET Framework 4.6.2 like plugins. | A compiled library (would force dependent-assembly packaging) |

### Deferred choices
- **Desktop (P3):** **Tauri 2** rather than Electron. It reuses the same bundle and is much smaller. It would add a background collector (a Rust or Node sidecar) so history doesn't depend on an open tab. Auth through MSAL Node or the system browser with loopback.
- **XrmToolBox (P3):** a thin C# WinForms plugin hosting **WebView2** with the same web bundle. The token is bridged from XrmToolBox's connection (`ServiceClient.CurrentAccessToken`) through `postMessage`. This reaches Plugin Trace Viewer's audience without writing a second UI, and it covers environments where importing a solution isn't allowed.
- **Standalone hosted mode with MSAL (maybe, P3):** one site for many environments. It needs an Entra app registration (bring your own client ID), so it's only worth adding if people ask for it.

## 2. Distribution and sign-in (no app registration)

| Channel | What ships | Sign-in |
|---|---|---|
| **Managed solution** `DataverseTrace_x_y_z_managed.zip` on GitHub Releases | Web resources under the `dvt_` prefix: `dvt_/index.html`, hashed JS chunks, the worker script, SVG icons. A site map sub-area "Dataverse Trace" and a small model-driven app, or the web resource opened full-page. | The user's existing Dataverse session. |
| **Demo site** on GitHub Pages | The same bundle with the HTTP transport turned off | None |

Build notes:
- Vite outputs **relative** asset paths (`base: './'`) and file names that are valid web resource names. Only web-resource file types are used (`.html`, `.js`, `.css`, `.svg`, `.png`). JSON is bundled into JS, and there are no web fonts, because the system font stack matches Fluent.
- Every file stays under the default 5 MB web-resource limit (`Organization.MaxUploadFileSize`) thanks to code splitting, and CI checks it.
- Spike S6 checks, in a real environment: loading the worker from a web resource URL, IndexedDB and Web Locks on the environment origin, same-origin `fetch` with the session (including from the worker), how the versioned `/%7B…%7D/WebResources/` path affects relative imports, and the platform CSP.

## 3. Repository structure

```
dataverse-trace/
├─ apps/
│  ├─ web/                      # React SPA
│  │  ├─ src/
│  │  │  ├─ app/                # shell, routing, providers, theme
│  │  │  ├─ host/               # HostContext: inEnvironment | demo | xrmToolBox
│  │  │  ├─ features/
│  │  │  │  ├─ explorer/
│  │  │  │  ├─ timeline/        # waterfall SVG components
│  │  │  │  ├─ dashboard/
│  │  │  │  ├─ expected/
│  │  │  │  ├─ watch/
│  │  │  │  ├─ graph/
│  │  │  │  └─ sessions/        # import/export/redaction UI
│  │  │  ├─ worker/             # worker entry, Comlink API surface
│  │  │  └─ components/         # shared UI (query bar, trace viewer, badges)
│  └─ docs/                     # Astro Starlight site
├─ solution/                    # solution metadata: solution.config.json, site map / app XML
├─ spikes/                      # throwaway experiments (s6-webresource: hosting diagnostics)
├─ tools/
│  └─ solution-packer/          # Node: build output → Dataverse solution zip
├─ packages/
│  ├─ core/                     # span model, correlation, analytics, insights, parsers, export
│  ├─ dataverse/                # transport, queries, mappers, capability probe, sync engine
│  ├─ store/                    # Dexie schema, repos, retention, migrations
│  └─ demo/                     # scenario generator + MockTransport
├─ dotnet/
│  └─ DataverseTrace.PluginHelper/   # source-only NuGet (P2)
├─ e2e/                         # Playwright tests + README GIF recorder
├─ fixtures/                    # anonymised real-world captures (golden tests)
├─ docs/
│  ├─ PLAN.md                   # this plan (entry point)
│  ├─ plan/                     # plan detail files
│  └─ adr/                      # architecture decision records
├─ .github/
│  ├─ workflows/                # ci.yml, deploy.yml, release.yml, gif.yml, codeql.yml
│  └─ ISSUE_TEMPLATE/
├─ CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md  LICENSE  README.md
└─ package.json  pnpm-workspace.yaml  tsconfig.base.json
```

## 4. Test strategy

| Layer | Tooling | What's covered |
|---|---|---|
| Unit: `core` | Vitest | Every correlation rule on its own; confidence scoring with the evidence recorded; the OData filter evaluator (a table of cases); the exception and stack-trace parser (fixtures of real .NET exceptions); `#dvt` header parsing; histogram merging and percentile accuracy (against exact values, within bucket error); insight rules; redaction; the session schema round-trip; the OTLP mapping. **Coverage gate: 90 %.** |
| Property-based | fast-check | Correlation: the output doesn't depend on input order, has no cycles, every inferred link has evidence, confidence stays in [0, 1], and exact children lie inside their parent's time range. Histogram merging is associative. |
| Golden tests | Vitest snapshots over `fixtures/` | Raw rows captured from real dev environments (anonymised by a built-in "fixture recorder" in dev builds) → the expected trace trees. Guards against regressions when the rules change. |
| Calibration | a script in `core` | Precision and recall of the inferred rules per confidence bucket, on fixtures labelled with the helper. Results published in the docs. |
| `dataverse` | Vitest + MockTransport / MSW | Query building, paging, 429 with `Retry-After`, resume after abort, watermark and deduplication, and capability-probe outcomes when privileges are missing. |
| `store` | Vitest + fake-indexeddb | Migrations, retention pruning, rollup writes. |
| Components | Vitest + Testing Library | Query bar parsing and autocomplete, trace viewer, waterfall geometry (the pure layout function is tested apart from rendering), accessibility checks with axe. |
| End-to-end | Playwright (Chromium + WebKit) against **demo mode** | Main journeys: open the demo → filter → open a trace → timeline → evidence popover; dashboard insight → drill down; expected vs. actual miss; simulated watch; export → import round-trip. Visual snapshots of key screens. |
| Live contract (optional, nightly) | Playwright/Vitest against a real dev environment, using secrets | Confirms the real Web API still behaves the way the mappers assume (columns, precision, paging). Skipped on forks. |
| Performance | Playwright + a trace-metrics script; `size-limit` | 100k-row filter time, timeline render time, bundle budget. Fails CI on regressions over 10 %. |

## 5. CI/CD (GitHub Actions)

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | PR, push | Install with the pnpm cache → lint → typecheck → unit and property tests with coverage (thresholds enforced in Vitest, summary posted to the job page) → build → size-limit → Playwright E2E on the demo → upload the report as an artifact. |
| `deploy.yml` | Push to `main` | Build `apps/web` and `apps/docs` → GitHub Pages (app at `/`, docs at `/docs/`). Lighthouse CLI runs against the built files in the same job and fails below 90. |
| `release.yml` | Push of a `v*` tag | Checks the tag matches the solution version, runs typecheck and the coverage gate, builds the bundle, packs the **unmanaged and managed zips** with `tools/solution-packer`, and publishes a GitHub Release with the matching `CHANGELOG.md` section as its notes. (Planned: release-please; a hand-kept changelog and a manual tag were simpler for one maintainer.) The NuGet helper is published on a `helper-v*` tag (P2). |
| `gif.yml` | Manual or on release | Playwright runs the demo script at a fixed viewport, records video → ffmpeg → optimised GIF and WebM → a PR that updates the README media. |
| `codeql.yml` | Weekly, PR | CodeQL for JS/TS (and C# once the helper exists). |
| Dependabot | Weekly | GitHub's built-in dependency updates, grouped. |

**Cost: $0.** Every item above is free for a public GitHub repository (Pages, standard Actions runners, CodeQL, Dependabot, Releases). No Azure subscription or third-party service is needed. The only optional spend is a custom domain.

Branch protection on `main`: CI must pass, merges are squash-only, and commits follow Conventional Commits.

Without PR preview deploys, reviewers run `pnpm dev` locally, or look at the Playwright report and screenshots attached to the CI run.

## 6. Engineering conventions

- ADRs for each lasting decision (the first ones: 0001 no backend; 0002 span model; 0003 Dexie; 0004 Fluent UI; 0005 exact vs. inferred links; 0006 Entra strategy).
- `core` is framework-free, and every exported function is documented with TSDoc (the docs site renders the API reference).
- Feature flags (`settings.experimental.*`) for inferred rules that are still being calibrated.
- An accessibility check (axe) in both component and E2E tests.
- Issue templates: bug (with an "attach a redacted `.dvtrace.json`" prompt), feature, and a "correlation got it wrong" report that captures a fixture.

## 7. Implementation notes for v0.1 (differences from the plan above)

| Planned | What v0.1 does | Why |
|---|---|---|
| ECharts for charts | Small custom SVG charts (`apps/web/src/components/charts.tsx`): stacked columns, heatmap, sparkline | Three simple forms didn't justify a large dependency. They follow the validated palette and mark specs, with tooltips, legends and a table view. ECharts can come back if charts get richer. |
| CodeMirror 6 for trace text | A light custom viewer (line numbers, find with next/previous, GUID highlighting, JSON pretty-printing) | Trace text is at most 10 KB, so a full editor isn't needed. |
| TanStack Router, Zustand | A tiny hash router (`router.ts`) and React state with `useSyncExternalStore` | Four routes; web resources need hash routing anyway. |
| Managed solution zip | **Unmanaged** zip from `tools/solution-packer`. *Since v0.2: a managed zip too* (same content, `<Managed>1</Managed>`), still to be imported once to confirm | A managed package differs from an unmanaged one by that flag for web-resource-only solutions. Dataverse won't install it over an unmanaged install of the same solution. |
| Stable file names everywhere | Stable names for web resources; **content-hashed names for GitHub Pages** (`DVT_TARGET=pages`) | Dataverse busts caches with its version token; a static host doesn't, so stable names would serve stale scripts after a deploy. |
| `exactOptionalPropertyTypes` everywhere | On in `core`, `dataverse`, `store`, `demo`; off in `apps/web` | It clashes with Fluent UI's prop types, and the domain packages are where it catches real bugs. |
| Insights in v0.3 | A first set of rule-based findings is already on the v0.1 dashboard (loop depth, no filtering attributes, slow sync step, error rate, tracing off, trace text hidden) | They were cheap to compute from the step statistics and make the dashboard useful straight away. |

## 8. Implementation notes for v0.2

| Planned | What v0.2 does | Why |
|---|---|---|
| I2 one-to-one assignment across saves | One-to-one pairing among **the saves of one record** (greedy, best score first); a **competitor-share** factor for saves of other records; low-confidence links are shown with their percentage | A record story reads one record's audit history only, so other records' saves are known only through their plug-in operations. Measured accuracy is in architecture §7. |
| Cross-check flow triggers with `callbackregistration` | Each active flow is marked `found` or `missing` during process sync by matching table, changes, filtering columns and filter expression; `missing` makes the flow "can't tell" with a reason. Unreadable registrations mean "not checked", never "missing" | Triggers still come from `clientdata`, parsed tolerantly; spike S3 needs a real solution-aware flow to confirm both layouts. |
| zod for the session schema | A hand-written validator in `packages/core/src/session.ts` (`validateSession`), with a 25 MB cap and clear error messages | One schema didn't justify a dependency. Tests cover it, including tampered files. |
| Redaction preview | The export dialog shows the exact JSON that will be saved. Redaction is consistent (the same value always gets the same placeholder; GUIDs become `00000000-0000-4000-8000-…`), so links survive | Names are replaced wherever they appear (span names, evidence, trace text), not only in known fields. |
| Watch polling every 2 s | Trace logs and system jobs every 2 s; flow runs, trace text and audit every third poll; audit details only for saves made while watching | Keeps watch at about 1.5 requests a second (NFR-P6: at most 2). |
| Trace-setting restore on tab close | A `pendingRestore` marker in IndexedDB is written **before** the switch; Stop restores and clears it; the page also sends a `keepalive` PATCH on `pagehide`; the next start restores any marker left behind | The worker can't finish work after the tab closes, but a keepalive request can. |
| Record picker search | `contains(<primary name>, …)` on the table's entity set, plus records seen in system jobs; model-driven URLs are parsed for `etn` and `id` | Works for any table, with one `EntityDefinitions` call per table. |
| Demo scenarios 6 and 7 | Every committed save is audited with old and new values; plug-in steps run only when their filtering attributes changed; rejected saves roll back (no audit); flows have real trigger definitions. Scenario 6: the rollup on policy create never starts "Sync account to marketing". Scenario 7: three status changes within 2 s. Watch mode in the demo has **Simulate save** | Gives expected vs. actual and I2 real answers to check against. |
| Coverage gate 90 % on `core` | `pnpm coverage` (in CI and releases): 90 % of lines, statements and functions in `packages/core`; branches have an 80 % floor while they catch up | At the time: lines 98 %, statements 95 %, functions 96 %, branches 83 %. |
| Playwright E2E (Chromium + WebKit), visual snapshots | Chromium only, in `apps/web/e2e`, against the demo build: the tour, explorer → timeline → evidence, record story with an inferred flow, expected vs. actual (scenario 6), simulated watch, export → import, and a rejected file. No visual snapshots yet | Snapshots differ across operating systems and fonts; WebKit can come with them. Locally, `PW_CHANNEL=msedge` uses an installed browser. |
| README GIF recorded in CI | `pnpm --filter @dvt/web readme-gif` records `docs/media/demo.gif` locally (Playwright screenshots encoded with gifenc, about 0.5 MB) | Committing the GIF keeps the README working without a CI artifact; rerun it after UI changes. |

## 9. Implementation notes for v0.3

| Planned | What v0.3 does | Why |
|---|---|---|
| `rollupsHourly` with a dense `Uint32Array(64)` histogram | One row per step per UTC hour (`core/rollup.ts`), with a **sparse** histogram (`[bucket, count, …]` pairs), constructor time, max depth and truncated-text counts. The store rebuilds the touched hours on every write (trace rows and trace text), so rollups always match the rows still held; version 3 of the database builds them for existing history on upgrade | Most steps fall in a few buckets an hour, so sparse rows are several times smaller over 400 days. Rebuilding whole hours keeps re-read rows from being counted twice |
| Dashboards read rollups, never raw rows | The dashboard reads **raw rows while they cover the range** (exact percentiles, as in v0.2) and switches to rollups for ranges older than the kept rows, marking percentiles as estimates (≈). Percentiles from rollups are interpolated geometrically inside their bucket | Exact numbers where they exist. Bucket upper bounds jump 25 % at a time, which made period-to-period changes flicker between "no change" and "▲ 25 %" |
| Trends | Changes against the previous period (▲/▼ on KPIs and steps) compare **like for like**: raw with raw when raw rows cover both periods, rollups with rollups otherwise, and volumes per hour of data collected. No comparison when less than half the previous period was collected. Coverage is a KPI tile; time before local history starts counts as a gap | Comparing an exact p95 with an estimated one would report the estimation error as a change |
| Retention (raw 30 d, blobs 14 d, rollups 400 d) | Applied after a sync at most every 6 hours (`LocalStore.prune`). When raw rows are pruned, the store records where complete raw history starts (`rawFrom`), which is what switches the dashboard to rollups | It wasn't applied before v0.3 |
| Insights as pure functions in `core` | `core/insights.ts`: 15 rules, each with evidence lines and an explorer query; thresholds in `InsightThresholds`, stored per environment in the store's meta table and edited in a dialog. The error spike compares the last 24 h with the 7 days before, from rollups. Re-entry needs **3 or more depths** of one operation, and steps that loop together are one finding | Two depths are often innocent (an account update that updates a parent account); a chain of them is how loops look |
| Platform stats snapshot on every sync (S8) | `plugintypestatistics` is read at most every 15 minutes, and a snapshot is kept only when a row's `modifiedon` changes (`${id}@${modifiedon}`). The panel reports what the snapshots show (median refresh interval, whether counts ever drop) and marks trends as experimental | Storing every read would add thousands of identical rows a day; versions alone also answer half of S8 (how often the counters refresh) |
| Cascade graph with React Flow + elkjs | `core/cascade.ts`: the graph comes from **assembled traces** (R3 parent → the R2 members of the nested request), cycles from Tarjan's algorithm (iterative), and a small layered layout (depth-first cycle breaking, longest-path layers, barycentre ordering) drawn as SVG. Links where every observation had more than one possible parent are hidden by default | The graph uses exactly the links the timeline draws. elkjs alone is about 1.4 MB against the web resources' 5 MB limit, and cascades have tens of nodes, like the charts that replaced ECharts in v0.1 |
| Critical path | `criticalPath` in `core/layout.ts`: from the root that finishes last, walk back taking the child that finished last before each point (as Jaeger does), and account each span's own time and queue wait. The timeline shows the path's top contributors ("PolicyErpSync 3.00 s (53 %) · … waited 2.00 s in the queue") | In a Dataverse pipeline steps run one after another, so most spans are on the path; the time breakdown is what answers "why is this save slow" |
| Minimap, collapse by depth, confidence threshold | A minimap under the toolbar (drag to zoom, click to move the window), "Collapse below depth N" by Dataverse depth (not tree level), and a link filter (all, ≥ 50 %, exact only) that says how many rows it hides | — |
| Demo | Rollups for days 14–90 replayed from the first generated week with slowly growing volume and a 3-day gap; a mail relay outage (error spike), failing ERP exports whose trace text hits 10 KB, and a heavier ERP constructor. The new incidents are applied after generation and draw from no random stream, so every earlier scenario is unchanged. The demo's statistics model a rolling 24-hour window refreshed hourly | Each new rule and panel has something real to find in the demo; the existing tests and journeys keep their data |
| Playwright journeys | Added: 90-day dashboard, period comparison, error spike → explorer (last 24 h), thresholds save and restore, platform statistics, cascades (loop → trace, table filter), timeline tools (depth, critical path, minimap, link filter) | — |
