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
| `release.yml` | Push to `main` | **release-please**: Conventional Commits → changelog, version tags, GitHub Release. On release: build the web-resource bundle → `tools/solution-packer` → attach the **solution zip** to the release. (Open question: the packer makes unmanaged zips today. Producing a managed zip without an environment needs checking; fallback: publish unmanaged, which uninstalls by deleting the `dvt_` web resources.) The NuGet helper is published on a `helper-v*` tag (P2). |
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
| Managed solution zip | **Unmanaged** zip from `tools/solution-packer` | Producing a managed zip without an environment is still an open question. Uninstalling means deleting the `dvt_/app/*` web resources plus the solution. |
| Stable file names everywhere | Stable names for web resources; **content-hashed names for GitHub Pages** (`DVT_TARGET=pages`) | Dataverse busts caches with its version token; a static host doesn't, so stable names would serve stale scripts after a deploy. |
| `exactOptionalPropertyTypes` everywhere | On in `core`, `dataverse`, `store`, `demo`; off in `apps/web` | It clashes with Fluent UI's prop types, and the domain packages are where it catches real bugs. |
| Insights in v0.3 | A first set of rule-based findings is already on the v0.1 dashboard (loop depth, no filtering attributes, slow sync step, error rate, tracing off, trace text hidden) | They were cheap to compute from the step statistics and make the dashboard useful straight away. |
