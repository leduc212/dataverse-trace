# Spike S6: web resource diagnostics

A throwaway diagnostics page that answers the question the whole architecture depends on: **can Dataverse Trace run as web resources inside an environment**, calling the Web API with the user's existing session (no app registration)?

While it's running inside a real environment it also answers three other open questions from [the research notes](../../docs/plan/research.md#2-things-not-yet-verified-spikes-before-building-on-them):

| Spike | Question |
|---|---|
| **S6** | Does the Web API work with the session from the page **and from a module worker**? Do dynamic imports, IndexedDB, Web Locks, `CompressionStream` and `BroadcastChannel` work on the environment's origin? What MIME type and CSP does the platform serve? |
| **S1** | Do trace-log, system-job, flow-run and audit timestamps come back with milliseconds or whole seconds (Web API and FetchXML)? |
| **S2** | What does `plugintracelog.createdby` hold: the calling user, the step's impersonated user, or SYSTEM? |
| **S5** | Can an async trace-log row be matched to its system job through `correlationid` + `owningextensionid`? |

The page only sends **GET** requests. It writes nothing to Dataverse. Its only local writes are a temporary IndexedDB database, which it deletes again.

## Build

```bash
pnpm install
```

```bash
pnpm pack:spike
```

This produces `spikes/s6-webresource/out/DataverseTraceSpikeS6_0_0_2.zip`, an unmanaged solution containing 5 web resources under `dvt_/spike/`. Importing a newer version over an older one updates the same web resources (their IDs are derived from their names).

Findings so far are in [research.md §2a](../../docs/plan/research.md#2a-spike-results-so-far).

## Get useful data first (optional but recommended)

S1, S2 and S5 need trace-log rows to look at. Before running the page:

1. Set **plug-in trace logging to All** (Power Platform admin center → environment → Settings → Product → Features… or the classic *Settings → Administration → System Settings → Customization* tab).
2. Trigger **at least one sync and one async custom plugin step**: save a record that has them registered.
   If the environment has no custom plugins, those three sections will just say "no data". That's fine; S6 is the priority, and a tiny test plugin can be added later.

## Import and run

1. Go to [make.powerapps.com](https://make.powerapps.com) → your dev environment → **Solutions** → **Import solution** → pick the zip → **Import**.
2. Click **Publish all customizations**.
3. Open `https://<your-org>.crm<N>.dynamics.com/WebResources/dvt_/spike/index.html` in the same browser (you must already be signed in to the environment).
4. The checks run automatically. Click **Copy results as JSON** (user names and the org URL are masked by default) and paste the result back into the chat.

Optionally, also open the page from inside the solution (select the `index.html` web resource and preview it). If that URL has a `/%7B…%7D/WebResources/` version segment, run the checks there too. The *Page location* row shows which variant you're on.

## Remove it afterwards

It's an unmanaged solution, so deleting the solution alone leaves the web resources behind:

1. Open the **Dataverse Trace - Spike S6 diagnostics** solution, select the five `dvt_/spike/…` web resources → **Delete from this environment**.
2. Delete the solution, then **Publish all customizations**.
3. Put the trace-log setting back to what it was.
