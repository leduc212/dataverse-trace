# Dataverse Trace: product and technical plan

> **Status (2026-09-24):** plan agreed. **v0.1 and v0.2 are implemented** and waiting to be tested in a real environment (see the milestone table). Decisions are [at the end](#open-decisions).

| Document | Contents |
|---|---|
| **PLAN.md** (this file) | Vision, users, use cases, positioning, scope, roadmap, portfolio strategy, open decisions |
| [plan/features.md](plan/features.md) | Every feature with its priority, plus wireframes of the key screens |
| [plan/requirements.md](plan/requirements.md) | Functional and non-functional requirements, permissions, supported environments |
| [plan/architecture.md](plan/architecture.md) | System diagram, modules, sync engine, data model, span model, correlation rules and confidence scoring |
| [plan/engineering.md](plan/engineering.md) | Tech stack with the reasons for each choice, Entra app strategy, repo structure, tests, CI/CD |
| [plan/risks.md](plan/risks.md) | Risks and limitations, with how each is mitigated |
| [plan/research.md](plan/research.md) | Facts checked against Microsoft docs, corrections to the brief, spikes still to run |

---

## Vision

**One-line pitch:** *See everything that ran when a Dataverse record was saved (plugins, system jobs, flows and audit) on one timeline, and see how it behaves over weeks, not just the last 24 hours.*

**Longer:** Debugging a save in Dataverse today means jumping between the plug-in trace log, system jobs, flow run history and audit history, then lining up GUIDs and timestamps by hand. Dataverse Trace is a free, open-source web app that runs **inside your environment** as a small solution you import (no server, no app registration, no Azure), with a public demo site that needs nothing at all. It gathers those sources into one **waterfall timeline** like a distributed-tracing tool, explains **what should have run and why something didn't**, and keeps a **local history** so there are dashboards and trends even though the platform deletes trace logs after about a day. It starts as a better plugin trace viewer and goes on from there.

## Target users

| Persona | What they need | How the app helps |
|---|---|---|
| **Pro-code Dataverse developer** (primary; also the author) | Find out why a save is slow or failing; understand the plugin chain; check a deployment. | Explorer, timeline, expected vs. actual, watch mode, compare traces |
| **Power Platform solution architect** | Know what's registered and how it interacts; spot loops and risky registrations. | Expected vs. actual, cascade graph, insights |
| **Tester or support engineer** | Attach evidence to a bug; read a colleague's capture without environment access. | Session export and import (redacted), copy as Markdown |
| **Low-code maker** (secondary) | Find out why a flow did or didn't trigger for a record. | Flow lane with confidence, the "why not" reasons |
| **Portfolio visitor** (a recruiter or hiring engineer) | Understand the project in 60 seconds. | Demo mode with a guided tour, the README GIF, the docs site |

## Core use cases

1. **"This save is slow."** Open the record's last save → waterfall → the critical path shows a 3.4 s sync ERP call in post-operation at depth 2.
2. **"Something failed and I only have the error dialog."** Paste the correlation ID → the trace shows the failing step, its exception parsed, and what ran before the rollback.
3. **"Why didn't my flow or plugin fire?"** Expected vs. actual for `account / Update / {statuscode}` → the flow's filtering columns don't include `statuscode`.
4. **"What happens when I do X?"** Watch a record → perform the action in the app → the timeline fills in live.
5. **"Did last week's deployment make things worse?"** Dashboard trend and step p95 before and after → compare two traces.
6. **"Are there loops or wasteful steps?"** Insights: an Update step without filtering attributes ran 400 times today; depth 8 reached.
7. **"Send this to a colleague."** Export a redacted `.dvtrace.json` → they drag it into the app, no sign-in needed.

## Positioning

| | Plugin Trace Viewer (XrmToolBox) | VS Code Trace Viewer | App Insights + KQL | **Dataverse Trace** |
|---|---|---|---|---|
| Plugin log browsing and filtering | ✅ strong | ✅ | via queries | ✅ aims for parity or better (full-text, query bar, 100k rows) |
| Correlation view | ✅ plugin traces only | ✗ | ✅ with a KQL query | ✅ **plugins + system jobs + flows + audit** |
| Record-level story | ✗ | ✗ | partial | ✅ exact where possible, inferred **with confidence** where not |
| Expected vs. actual | ✗ | ✗ | ✗ | ✅ |
| History and trends | ✗ (server's 24 h only) | ✗ | ✅ (paid, admin setup) | ✅ local, free |
| Setup | Windows + XrmToolBox | VS Code | Admin + Azure subscription | Import a free solution, then open it in the browser; **demo site with nothing installed** |
| Sharing | Excel export | ✗ | Workbook links | Redacted session files, Markdown, OTLP |

Plugin Trace Viewer already has a plugin-only "related executions" view, so correlation grouping on its own isn't a differentiator. What sets this project apart is **several sources**, **honest inference**, **expected vs. actual**, **history**, and **no install**. Microsoft's own plug-in monitoring in the Dataverse accelerator is "[deprioritized and won't be delivered](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/dataverse-accelerator/plugin-monitoring)". See [research.md](plan/research.md).

## Scope

**In scope for v1.0:** everything marked P0 to P2 in [features.md](plan/features.md): explorer, timeline (exact and inferred links), dashboard and insights, expected vs. actual, watch mode, cascade graph, sharing (JSON, Markdown, OTLP), compare traces, NuGet helper, demo mode, docs site.

**Out of scope for v1.0:** writing to Dataverse (apart from the opt-in trace-setting switch), deleting logs, on-premises and sovereign clouds, a hosted backend or shared team history, the desktop and XrmToolBox shells (P3), mobile layouts.

## Roadmap

Rough sizing assumes one developer working part-time. Every milestone ends with a deployed, demoable build and a short write-up.

| Milestone | Goal | Contents | Size |
|---|---|---|---|
| **M0: Foundations** ✅ mostly done | Remove the technical unknowns | Spikes S1, S2, S5 and S6 (see [research](plan/research.md#2-things-not-yet-verified-spikes-before-building-on-them)); monorepo, CI and deploy pipeline; span model and first ADRs; demo generator skeleton; a "hello" web resource solution that calls `WhoAmI`, starts a web worker and writes to IndexedDB inside a real environment. **Done:** S6 confirmed; S1 partly answered (system jobs and flow runs return whole seconds); S2 and S5 wait for the test plugins (`dotnet/TestPlugins`). | 2 weeks |
| **M1 → v0.1 "A better trace viewer"** (MVP) ✅ built, to be tested | Excellent at the basics, and already different | Connect, capability probe, sync of trace logs, system jobs and registrations, local history with coverage. **Explorer** (all P0 items). **Timeline by correlation ID** (exact rules R1–R5, R9). **Dashboard basics** (KPIs, step table, top lists, heatmap). **Demo mode** with scenarios 1 to 5. Released as a **solution zip** plus the demo site. README with a GIF. **Built:** everything listed. The README GIF is recorded from the demo by a Playwright script (`pnpm --filter @dvt/web readme-gif`). Releases carry an unmanaged and a managed zip; the managed one hasn't been imported yet (see engineering §7). | 5–6 weeks |
| **M2 → v0.2 "The record story"** ✅ built, to be tested | The core idea | Flow runs and flow events; audit on demand; **record-save timeline** with inferred I1/I2 links, confidence and evidence; **expected vs. actual**; **watch mode** (with the optional trace-setting switch); session export and import; copy as Markdown; demo scenarios 6 and 7 plus the guided tour. Spikes S3, S4. **Built:** everything listed, including one-to-one pairing of a record's saves with flow runs and the `callbackregistration` cross-check. The flow-trigger parser is tolerant because S3 (the `clientdata` layout) still needs a real flow to confirm it (see engineering §8). | 5–6 weeks |
| **M3 → v0.3 "Insights"** | Beyond debugging | Trends from rollups with coverage bands; platform-stats snapshots (S8); **insight rules**; **cascade graph** with cycle detection; timeline polish (critical path, minimap). | 3–4 weeks |
| **M4 → v1.0 "Polish and share"** | Portfolio-ready | OTLP export (S7); compare traces; static loop-risk graph; the **NuGet helper** plus published calibration of the inferred rules; docs site; accessibility audit; performance hardening against the NFR budgets; a launch post. | 4–5 weeks |
| **Later (P3)** | Reach and continuity | Tauri desktop with a background collector; XrmToolBox shell; an optional standalone hosted mode (MSAL) for many environments on one site; sovereign clouds; an optional team collector; an encrypted local store. | — |

**Suggested cut line if time runs short:** ship v0.1 and v0.2. Together they already cover the one-line pitch.

## What makes it stand out as a portfolio piece

1. **A live demo with no sign-in:** the first screen offers **Try demo** (fictional "Harbor Insurance", scripted incidents, a 5-step guided tour). A reviewer sees the waterfall within 10 seconds.
2. **An automatically generated README GIF:** a Playwright script drives the demo, and CI turns the recording into a GIF, so the media never goes stale. Plus a 2-minute narrated video.
3. **A docs site** (Astro Starlight): getting started, the permissions matrix, "How correlation works" with an **interactive mini-waterfall** you can change, **published calibration numbers** for the inferred links, a data-handling and security page, and the ADRs.
4. **Engineering signals:** a framework-free `core` package with ≥ 90 % coverage and property-based tests; performance budgets in CI; Lighthouse ≥ 90; axe accessibility checks; Conventional Commits with automated releases; CodeQL; all of it on free GitHub tooling.
5. **Honest design:** exact and inferred links drawn differently, confidence with its evidence, caveats shown, and a read-only-by-default principle. These are the parts that come across well in interviews.
6. **Domain depth:** stage and rank ordering, filtering-attribute analysis, async queue time, flow trigger parsing. It shows real Dataverse expertise, not just a CRUD app.
7. **Write-ups:** one short post per milestone (e.g. "Correlating Dataverse plugins, jobs and flows without a record ID").

## Cost

**Building and running this costs $0.** It's a public GitHub repo with GitHub Pages hosting, GitHub Actions CI, CodeQL, Dependabot and Releases, all free for public repos. No backend, database, Azure subscription or paid service. A dev environment for testing is free through the [Power Apps Developer Plan](https://learn.microsoft.com/en-us/power-platform/developer/plan). Optional extras: a custom domain (about $10–15 a year) and code signing (only if a desktop build is ever shipped; see below).

## How it connects: no app registration needed

The same React bundle is built for two hosts:

| Host | Who it's for | Sign-in | Data |
|---|---|---|---|
| **Demo site** (GitHub Pages) | Portfolio visitors, and anyone opening a shared `.dvtrace.json` | **None** | Built-in demo scenarios and imported session files |
| **Dataverse solution** (HTML and JS web resources, released as a managed solution zip on GitHub Releases) | Real use against a real environment | **None of our own.** It runs on the environment's own origin, in the Dataverse web app's security context, and calls `/api/data/v9.2` with the user's existing session. No MSAL, no tokens, no Entra app, no extra licence. | The user's environment, with history stored in that environment origin's IndexedDB |

Installing means importing the solution once per environment (System Customizer or System Administrator), then opening **Dataverse Trace** from a model-driven app's site map or its web-resource URL. Removing it is a normal solution uninstall. The app still writes nothing to Dataverse unless the user opts in (watch mode's trace-setting switch).

Options considered and rejected:
- **A hosted site with MSAL sign-in:** needs an Entra app registration (the bring-your-own client ID wizard, or a shared multi-tenant app that many tenants block without publisher verification). It could come back later as an optional mode if people want one site for many environments.
- **Power Apps Code Apps:** no registration, but every user needs a Power Apps Premium licence.
- **Reusing Microsoft's public client IDs:** their redirect URLs don't match a hosted site, and it isn't a supported use.

## Web app or desktop app?

| | **Web app** (static site) | **Desktop app** (Tauri/Electron) | **XrmToolBox tool** |
|---|---|---|---|
| Cost | $0 (GitHub Pages) | $0 to build. **Signing isn't free**: unsigned Windows installers trigger SmartScreen warnings, and macOS needs a $99/year Apple Developer account. Free signing for open source exists (e.g. SignPath Foundation) but needs an application and approval. | $0, published through the XrmToolBox tool store (NuGet) |
| Portfolio visitors | **Click a link → demo in 10 s** | Download, install, click past warnings. Most recruiters won't. | Needs Windows and XrmToolBox |
| Sign-in | **None**: installed as a Dataverse solution, it uses the environment's own session (see above) | Needs an Entra app registration | **None**: reuses XrmToolBox's saved connections |
| History beyond 24 h | Only while a tab is open | **Best**: a tray app can keep syncing in the background | While XrmToolBox is open |
| Updates | Instant on deploy | Needs an auto-update channel | XrmToolBox handles it |
| Platforms | Any OS | Win/Mac/Linux builds to maintain | Windows only |

**Recommendation:** build the **web app first**. It's free, needs no install, and makes the demo one click, which matters most for a portfolio. Keep `core` framework-free (already the plan), so the same bundle can later be wrapped as:
- an **XrmToolBox tool** (WebView2 hosting the web bundle, using XrmToolBox's connection). This is the cheapest way to reach existing Plugin Trace Viewer users, and it suits environments where importing a solution isn't allowed. It would be the second target, not a desktop app.
- a **Tauri desktop app** with background sync, only if continuous history turns out to matter more than install friction.

## Open decisions

These change what gets built, so they're yours to make. Each has a recommendation.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | ✅ **Decided (2026-09-24): $0 infrastructure.** GitHub Pages (demo and docs), GitHub Actions, GitHub Releases. No Azure, no paid services. | — | — |
| **D2** | ✅ **Decided (2026-09-24): runs as Dataverse web resources.** A managed solution uses the user's existing session, so there's no app registration and no MSAL. The same bundle runs on the demo site with no sign-in. XrmToolBox tool later (P3) for environments that can't import solutions. Desktop app not planned. | — | — |
| **D3** | ✅ **Decided (2026-09-24): Fluent UI v9.** Native Power Platform look, and it fits inside a model-driven app. | — | — |
| **D4** | ✅ **Decided (2026-09-24): v0.1 includes the correlation timeline** (exact links R1–R5, R9). | — | — |
| **D5** | Test environment and fixtures | Do you have a dev environment where you're System Administrator and can register test plugins and flows for the M0 spikes? Can anonymised captures from it go into the public `fixtures/` folder? | **Still open**: needed before M0. A free [Power Apps Developer Plan](https://learn.microsoft.com/en-us/power-platform/developer/plan) environment works. |
| **D6** | ✅ **Decided (2026-09-24): NuGet helper in v1.0** (P2), as planned. | — | — |
| **D7** | ✅ **Decided (2026-09-24): keep the name "Dataverse Trace", MIT licence**, no custom domain for now. | — | — |

Once these are settled, the next step is M0. **Spike S6 comes first:** a "hello" web-resource solution that proves the connection model (worker, IndexedDB, session `fetch`) in a real environment. Then the other spikes, then scaffolding the monorepo.
