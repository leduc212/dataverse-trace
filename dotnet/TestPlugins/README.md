# Test plugins

Four small plugins on the **account** table, so you can try Dataverse Trace in a dev environment that has no custom plugins yet. They only write trace lines. Every other effect is opt-in: you type a command into the account's **Description** and save.

| Command in Description | What happens | What to look at in Dataverse Trace |
|---|---|---|
| *(nothing)* | Validate, post-update, audit and an async notify all run and trace | A normal operation: sync pipeline + a system job with queue time |
| `#slow` | `AccountPostUpdate` waits 2.5 s | Dashboard: slow sync step; timeline: one long bar |
| `#nest` | `AccountPostUpdate` updates Fax, so `AccountAudit` runs again at depth 2 | Timeline: a nested request inside `AccountPostUpdate` |
| `#fail` | `AccountValidate` throws and the save fails | Explorer: `err`; parsed exception; the rest of the pipeline never ran |
| `#loop` | `AccountPostUpdate` keeps updating the description until depth 8, then throws | Dashboard finding "Depth 8 reached"; a deep nested timeline |
| `#failasync` | `AccountNotifyAsync` throws | A failed system job in the async lane |

`AccountAudit` has **no filtering attributes** on purpose, so it runs on every account update. That's what the "no filtering attributes" finding looks like.

## Build

Needs the .NET SDK (8 or later). Visual Studio isn't needed.

```bash
dotnet build dotnet/TestPlugins -c Release
```

The output is `dotnet/TestPlugins/bin/Release/net462/DataverseTrace.TestPlugins.dll`, signed with the test key in this folder.

## Register (Plugin Registration Tool or XrmToolBox)

1. **Register New Assembly** → pick the DLL → isolation *Sandbox*, location *Database* → register the four types.
2. Register these **steps** (primary entity `account`, message `Update`):

| Plugin type | Stage | Mode | Order | Filtering attributes | Image |
|---|---|---|---|---|---|
| `AccountValidate` | Pre-validation | Synchronous | 1 | `description` | – |
| `AccountPostUpdate` | Post-operation | Synchronous | 1 | `description` | Post-image named `post` with `description` |
| `AccountAudit` | Post-operation | Synchronous | 2 | *(none: leave empty)* | – |
| `AccountNotifyAsync` | Post-operation | **Asynchronous** | 1 | `description` | Post-image named `post` with `description` |

3. Set **plug-in trace logging to All** (environment settings, or Plug-in Registration Tool → Settings).
4. Open any account, type a command into Description (for example `testing #nest #slow`), and save. Then open Dataverse Trace and press Sync.

## Remove

In the Plugin Registration Tool, unregister the assembly (its steps go with it). Put the trace-log setting back to what it was.
