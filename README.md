# dataverse-trace

**See everything that ran when a Dataverse record was saved (plugins, system jobs, flows and audit) on one timeline, with dashboards over weeks instead of the last 24 hours.**

Dataverse Trace runs inside your environment as a small solution of web resources. There's no server and no app registration, and it uses the session you're already signed in with. A demo site with built-in sample data is planned.

> **Status:** early development. The plan is in [docs/PLAN.md](docs/PLAN.md). The first milestone (M0) is under way, starting with [spike S6](spikes/s6-webresource/README.md), which checks that the web-resource approach works.

## Repository

| Path | What's there |
|---|---|
| `docs/` | Product and technical plan |
| `spikes/s6-webresource/` | Diagnostics page that proves the web-resource hosting model (also probes spikes S1, S2, S5) |
| `tools/solution-packer/` | Node tool: built files → importable Dataverse solution zip |

## Develop

Requires Node 24+ and pnpm 10.

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm pack:spike
```

## License

[MIT](LICENSE)
