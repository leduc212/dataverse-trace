# Solution packer

Turns a folder of built static files into an importable **Dataverse solution zip** of web resources. It runs on Node alone: no .NET, no Power Platform CLI.

```bash
node tools/solution-packer/src/cli.ts --config path/to/solution.config.json
```

`solution.config.json`:

```json
{
  "uniqueName": "DataverseTraceSpikeS6",
  "displayName": "Dataverse Trace - Spike S6 diagnostics",
  "description": "…",
  "version": "0.0.1",
  "publisher": { "uniqueName": "dataversetrace", "displayName": "Dataverse Trace", "prefix": "dvt", "optionValuePrefix": 72311 },
  "distDir": "dist",
  "webResourceRoot": "dvt_/spike/",
  "outDir": "out"
}
```

Rules it enforces:

- Every name starts with the publisher prefix (`dvt_`) and only uses letters, digits, `_`, `.` and `/`. That's stricter than the platform on purpose, which is why the Vite config turns off content hashes.
- Only web-resource file types (`html`, `css`, `js`, `xml`, `png`, `jpg`, `gif`, `xsl`, `ico`, `svg`, `resx`). Source maps and fonts are rejected.
- Each file is at most 5 MB (the default `Organization.MaxUploadFileSize`).
- **Stable IDs:** each web resource's GUID is derived from its name, so re-importing a new build updates the same web resources instead of failing on duplicates.
- **Deterministic output:** same input gives the same zip bytes.

Today it produces **unmanaged** solutions. Managed output is an open question (see `docs/plan/engineering.md`).
