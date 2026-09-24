import { formatted, getJson, hasFractionalSeconds, type ODataCollection } from './api.ts';
import { check, type CheckResult, type CheckOutcome } from './types.ts';

type Row = Record<string, unknown>;

export interface RunContext {
  userId?: string;
  /** Display names seen in results, masked in the exported JSON. */
  personalNames: Set<string>;
}

// The HTML spec's "JavaScript MIME type" list. Dataverse serves JS web resources as text/jscript,
// which is on it, so module scripts and workers load fine.
const JS_MIME =
  /^(application\/(x-)?(javascript|ecmascript)|text\/(x-)?(javascript|ecmascript)|text\/javascript1\.[0-5]|text\/jscript|text\/livescript)\b/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pickHeaders = (response: Response, names: string[]) =>
  Object.fromEntries(names.map((name) => [name, response.headers.get(name)]));

// ── Environment ──────────────────────────────────────────────────────────────

export function envChecks(): Promise<CheckResult[]> {
  return Promise.all([
    check('env.location', 'env', 'Page location', async () => {
      const versioned = /\/(%7B|\{)[^/]+(%7D|\})\/WebResources\//i.test(location.pathname);
      return {
        status: 'info',
        summary: `${location.pathname}${versioned ? ' (versioned path)' : ''}`,
        details: { href: location.href, versionedPath: versioned, userAgent: navigator.userAgent },
      };
    }),
    check('env.headers', 'env', 'Response headers and script MIME type', async () => {
      const [page, script] = await Promise.all([
        fetch(location.href, { credentials: 'same-origin', cache: 'no-store' }),
        fetch(import.meta.url, { credentials: 'same-origin', cache: 'no-store' }),
      ]);
      const pageHeaders = pickHeaders(page, [
        'content-type',
        'content-security-policy',
        'content-security-policy-report-only',
        'x-frame-options',
        'cache-control',
      ]);
      const scriptType = script.headers.get('content-type') ?? '';
      const csp = pageHeaders['content-security-policy'];
      return {
        status: JS_MIME.test(scriptType) ? 'pass' : 'fail',
        summary: `scripts served as "${scriptType}"; ${csp ? 'page has a CSP header (see details)' : 'no CSP header on the page'}`,
        details: { page: pageHeaders, script: pickHeaders(script, ['content-type', 'cache-control']) },
      };
    }),
  ]);
}

// ── S6: web resource hosting ─────────────────────────────────────────────────

export function whoAmICheck(ctx: RunContext): Promise<CheckResult> {
  return check('s6.page.whoami', 'S6', 'Web API from the page (session cookie)', async () => {
    const who = await getJson<{ UserId: string; OrganizationId: string }>('WhoAmI', { annotations: false });
    ctx.userId = who.UserId;
    return { status: 'pass', summary: `WhoAmI succeeded (UserId ${who.UserId})` };
  });
}

export function dynamicImportCheck(): Promise<CheckResult> {
  return check('s6.page.dynamic-import', 'S6', 'Code-split chunk via dynamic import()', async () => {
    const { lazyLoaded } = await import('./lazy.ts');
    return { status: 'pass', summary: lazyLoaded() };
  });
}

export function versionedPathCheck(): Promise<CheckResult> {
  return check('s6.versioned-path', 'S6', 'Loading under a versioned /%7B…%7D/ path', async () => {
    // Site maps and Xrm.Navigation open web resources under /%7B<version>%7D/WebResources/…. The
    // token only affects caching, so a made-up one should still be served. Relative imports then
    // resolve inside that path.
    // Resolve against the page URL, not import.meta.url: Vite rewrites `new URL('…', import.meta.url)`
    // into a bundled asset reference.
    const url = `${location.origin}/%7B000000000000000001%7D${new URL('lazy.js', location.href).pathname}`;
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !JS_MIME.test(type)) {
      return {
        status: 'warn',
        summary: `${response.status} "${type}" for a made-up version token; test via a site map later`,
        details: { url },
      };
    }
    const module = (await import(/* @vite-ignore */ url)) as { lazyLoaded: () => string };
    return {
      status: 'pass',
      summary: `served as "${response.headers.get('content-type')}" and imported: ${module.lazyLoaded()}`,
      details: { url },
    };
  });
}

export function workerChecks(): Promise<CheckResult[]> {
  const fail = (summary: string): CheckResult[] => [
    { id: 's6.worker.load', spike: 'S6', title: 'Module worker from a web resource', status: 'fail', summary },
  ];
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    return Promise.resolve(fail(`new Worker() threw: ${(error as Error).message}`));
  }
  return new Promise((resolve) => {
    const done = (results: CheckResult[]) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(results);
    };
    const timer = setTimeout(() => done(fail('worker did not respond within 15 s')), 15_000);
    worker.onerror = (event) =>
      done(fail(`worker error: ${event.message || 'failed to load (check the script MIME type and CSP)'}`));
    worker.onmessage = (event: MessageEvent<'ready' | CheckResult[]>) => {
      if (event.data === 'ready') {
        worker.postMessage('run');
        return;
      }
      done([
        { id: 's6.worker.load', spike: 'S6', title: 'Module worker from a web resource', status: 'pass', summary: 'loaded and responded' },
        ...event.data,
      ]);
    };
  });
}

// ── Organization settings ────────────────────────────────────────────────────

export function orgChecks(): Promise<CheckResult[]> {
  return Promise.all([
    check('org.settings', 'org', 'Organization settings', async () => {
      const columns = ['plugintracelogsetting', 'maxuploadfilesize', 'isauditenabled', 'flowruntimetoliveinseconds'];
      const details: Record<string, unknown> = {};
      // One request per column, so a column that doesn't exist doesn't hide the others.
      for (const column of columns) {
        try {
          const row = (await getJson<ODataCollection>(`organizations?$select=${column}`)).value[0] ?? {};
          details[column] = formatted(row, column) ?? row[column];
        } catch (error) {
          details[column] = `unavailable: ${(error as Error).message}`;
        }
      }
      return {
        status: 'info',
        summary: `trace log: ${details['plugintracelogsetting']}, max upload: ${details['maxuploadfilesize']} bytes, auditing: ${details['isauditenabled']}`,
        details,
      };
    }),
    check('org.messageblock', 'org', 'Trace text readable (messageblock)', async () => {
      const rows = (await getJson<ODataCollection>('plugintracelogs?$select=messageblock,createdon&$orderby=createdon desc&$top=10')).value;
      if (rows.length === 0) return { status: 'info', summary: 'no trace log rows yet' };
      const readable = rows.filter((r) => typeof r['messageblock'] === 'string' && r['messageblock'] !== '').length;
      return readable > 0
        ? { status: 'pass', summary: `${readable}/${rows.length} recent rows have trace text` }
        : {
            status: 'warn',
            summary: `0/${rows.length} recent rows have trace text: the plugins don't call Trace(), or this user isn't System Administrator`,
          };
    }),
  ]);
}

// ── S1: timestamp precision ──────────────────────────────────────────────────

function precisionOutcome(rows: Row[], columns: string[]): CheckOutcome {
  if (rows.length === 0) return { status: 'info', summary: 'no rows to inspect' };
  const samples = rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
  const verdicts = Object.fromEntries(
    columns.map((c) => {
      const values = samples.map((s) => s[c]).filter((v) => v !== null);
      const verdict = values.length === 0 ? 'no values' : values.some(hasFractionalSeconds) ? 'milliseconds' : 'seconds only';
      return [c, verdict];
    }),
  );
  const any = (v: string) => Object.values(verdicts).includes(v);
  return {
    status: any('milliseconds') && !any('seconds only') ? 'pass' : any('seconds only') ? 'warn' : 'info',
    summary: columns.map((c) => `${c}: ${verdicts[c]}`).join('; '),
    details: { samples },
  };
}

function precisionCheck(id: string, title: string, entitySet: string, columns: string[]): Promise<CheckResult> {
  return check(id, 'S1', title, async () => {
    const path = `${entitySet}?$select=${columns.join(',')}&$orderby=createdon desc&$top=5`;
    return precisionOutcome((await getJson<ODataCollection>(path)).value, columns);
  });
}

export function s1Checks(): Promise<CheckResult[]> {
  const fetchXml =
    '<fetch top="5"><entity name="plugintracelog"><attribute name="createdon"/>' +
    '<attribute name="performanceexecutionstarttime"/><order attribute="createdon" descending="true"/></entity></fetch>';
  return Promise.all([
    precisionCheck('s1.trace.webapi', 'Trace log timestamps (Web API)', 'plugintracelogs', [
      'createdon',
      'performanceexecutionstarttime',
      'performanceconstructorstarttime',
    ]),
    check('s1.trace.fetchxml', 'S1', 'Trace log timestamps (FetchXML)', async () => {
      const rows = (await getJson<ODataCollection>(`plugintracelogs?fetchXml=${encodeURIComponent(fetchXml)}`)).value;
      return precisionOutcome(rows, ['createdon', 'performanceexecutionstarttime']);
    }),
    precisionCheck('s1.asyncoperation', 'System job timestamps', 'asyncoperations', ['createdon', 'startedon', 'completedon']),
    precisionCheck('s1.flowrun', 'Flow run timestamps', 'flowruns', ['createdon', 'starttime', 'endtime']),
    precisionCheck('s1.audit', 'Audit timestamps (expected: milliseconds)', 'audits', ['createdon']),
  ]);
}

/**
 * The Web API may drop milliseconds when returning a value and still store them. Bisect with
 * `$filter=<id> eq … and <column> ge <value + offset>` to find the stored sub-second offset
 * (about 11 requests per value). Offset 0 for every value means seconds are all we can get.
 */
async function storedOffsetMs(entitySet: string, idColumn: string, id: string, column: string, value: string): Promise<number | null> {
  const base = Date.parse(value);
  if (Number.isNaN(base) || !GUID.test(id)) return null;
  const matches = async (offset: number) =>
    (
      await getJson<ODataCollection>(
        `${entitySet}?$select=${idColumn}&$filter=${idColumn} eq ${id} and ${column} ge ${new Date(base + offset).toISOString()}`,
        { annotations: false },
      )
    ).value.length > 0;
  // Invariant: matches(lo) is true, matches(hi) is false. Allow −1 s in case the API rounds up.
  let lo = -1000;
  let hi = 1000;
  if (!(await matches(lo)) || (await matches(hi))) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await matches(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function storedPrecisionCheck(): Promise<CheckResult> {
  return check('s1.stored', 'S1', 'Stored sub-second precision (filter bisection)', async () => {
    const targets: Array<{ entitySet: string; idColumn: string; column: string; orderBy: string }> = [
      { entitySet: 'plugintracelogs', idColumn: 'plugintracelogid', column: 'performanceexecutionstarttime', orderBy: 'createdon' },
      { entitySet: 'asyncoperations', idColumn: 'asyncoperationid', column: 'startedon', orderBy: 'createdon' },
      { entitySet: 'flowruns', idColumn: 'flowrunid', column: 'starttime', orderBy: 'createdon' },
    ];
    const findings = [];
    for (const t of targets) {
      let rows: Row[] = [];
      try {
        rows = (
          await getJson<ODataCollection>(
            `${t.entitySet}?$select=${t.idColumn},${t.column}&$filter=${t.column} ne null&$orderby=${t.orderBy} desc&$top=3`,
            { annotations: false },
          )
        ).value;
      } catch (error) {
        findings.push({ table: t.entitySet, column: t.column, error: (error as Error).message });
        continue;
      }
      for (const row of rows) {
        const returned = String(row[t.column]);
        try {
          const offset = await storedOffsetMs(t.entitySet, t.idColumn, String(row[t.idColumn]), t.column, returned);
          findings.push({ table: t.entitySet, column: t.column, returned, storedOffsetMs: offset });
        } catch (error) {
          findings.push({ table: t.entitySet, column: t.column, returned, error: (error as Error).message });
        }
      }
    }
    const offsets = findings.flatMap((f) => ('storedOffsetMs' in f && typeof f.storedOffsetMs === 'number' ? [f.storedOffsetMs] : []));
    if (offsets.length === 0) return { status: 'info', summary: 'no values could be bisected', details: findings };
    const nonZero = offsets.filter((o) => o !== 0).length;
    return {
      status: nonZero > 0 ? 'pass' : 'warn',
      summary:
        nonZero > 0
          ? `${nonZero}/${offsets.length} values have hidden milliseconds: stored precision is finer than what the API returns`
          : `all ${offsets.length} values are whole seconds in storage too (or the filter truncates)`,
      details: findings,
    };
  });
}

// ── S4: flow run ingestion delay and visibility ──────────────────────────────

export function s4Check(ctx: RunContext): Promise<CheckResult> {
  return check('s4.flowrun', 'S4', 'Flow run ingestion delay and visibility', async () => {
    const rows = (
      await getJson<ODataCollection>(
        'flowruns?$select=starttime,endtime,createdon,status,_ownerid_value&$filter=endtime ne null&$orderby=createdon desc&$top=50',
      )
    ).value;
    if (rows.length === 0) return { status: 'info', summary: 'no finished flow runs visible to this user' };
    const delays = rows
      .map((r) => (Date.parse(String(r['createdon'])) - Date.parse(String(r['endtime']))) / 1000)
      .filter((d) => Number.isFinite(d))
      .sort((a, b) => a - b);
    const at = (q: number) => delays[Math.min(delays.length - 1, Math.floor(q * delays.length))] ?? NaN;
    const owners = new Map<string, number>();
    for (const r of rows) {
      const name = formatted(r, '_ownerid_value');
      if (name) ctx.personalNames.add(name);
      const key = String(r['_ownerid_value']);
      owners.set(key, (owners.get(key) ?? 0) + 1);
    }
    const yours = owners.get(ctx.userId ?? '') ?? 0;
    return {
      status: 'info',
      summary: `row written ${at(0)}–${at(1)} s after the run ended (median ${at(0.5)} s, p90 ${at(0.9)} s) over ${delays.length} runs; ${owners.size} owner(s), ${yours}/${rows.length} runs owned by you`,
      details: { delaySecondsSorted: delays, runsPerOwner: [...owners.entries()].map(([owner, runs]) => ({ isYou: owner === ctx.userId, runs })) },
    };
  });
}

// ── S2: what plugintracelog.createdby holds ──────────────────────────────────

export function s2Check(ctx: RunContext): Promise<CheckResult> {
  return check('s2.createdby', 'S2', 'What plugintracelog.createdby holds', async () => {
    const rows = (
      await getJson<ODataCollection>(
        'plugintracelogs?$select=typename,mode,depth,pluginstepid,_createdby_value,_createdonbehalfby_value,createdon&$orderby=createdon desc&$top=50',
      )
    ).value;
    if (rows.length === 0) return { status: 'info', summary: 'no trace log rows yet' };

    const stepIds = [...new Set(rows.map((r) => r['pluginstepid']).filter((v): v is string => typeof v === 'string' && GUID.test(v)))];
    const stepRunsAs = new Map<string, string>();
    for (const id of stepIds.slice(0, 10)) {
      try {
        const step = await getJson<Row>(`sdkmessageprocessingsteps(${id})?$select=name,_impersonatinguserid_value`);
        const name = formatted(step, '_impersonatinguserid_value');
        if (name) ctx.personalNames.add(name);
        stepRunsAs.set(id, step['_impersonatinguserid_value'] ? `impersonates ${name ?? step['_impersonatinguserid_value']}` : 'calling user');
      } catch {
        stepRunsAs.set(id, 'step not readable');
      }
    }

    const combos = new Map<string, { typename: unknown; mode: unknown; createdBy: string; isYou: boolean; onBehalfOf: string | null; stepRunsAs: string; count: number }>();
    for (const row of rows) {
      const createdById = row['_createdby_value'] as string | undefined;
      const createdBy = formatted(row, '_createdby_value') ?? createdById ?? '(empty)';
      const onBehalfOf = formatted(row, '_createdonbehalfby_value') ?? null;
      for (const name of [createdBy, onBehalfOf]) if (name && !GUID.test(name) && name !== '(empty)') ctx.personalNames.add(name);
      const entry = {
        typename: row['typename'],
        mode: formatted(row, 'mode') ?? row['mode'],
        createdBy,
        isYou: createdById !== undefined && createdById === ctx.userId,
        onBehalfOf,
        stepRunsAs: stepRunsAs.get(row['pluginstepid'] as string) ?? 'unknown',
      };
      const key = JSON.stringify(entry);
      const existing = combos.get(key);
      if (existing) existing.count++;
      else combos.set(key, { ...entry, count: 1 });
    }
    const distinctCreators = new Set([...combos.values()].map((c) => c.createdBy)).size;
    const yours = rows.filter((r) => r['_createdby_value'] === ctx.userId).length;
    return {
      status: 'info',
      summary: `${distinctCreators} distinct createdby value(s) across ${rows.length} rows; ${yours} are your user`,
      details: [...combos.values()],
    };
  });
}

// ── S5: async trace ↔ system job correlation ─────────────────────────────────

export function s5Check(): Promise<CheckResult> {
  return check('s5.async-correlation', 'S5', 'Async trace ↔ system job correlation', async () => {
    const traces = (
      await getJson<ODataCollection>(
        'plugintracelogs?$select=correlationid,requestid,pluginstepid,depth,typename,performanceexecutionstarttime,performanceexecutionduration&$filter=mode eq 1&$orderby=createdon desc&$top=20',
      )
    ).value;
    if (traces.length === 0) {
      return { status: 'info', summary: 'no async plugin traces yet: run an async plugin step with tracing set to All, then run again' };
    }
    const seen = new Set<string>();
    const picked = traces.filter((t) => {
      const id = t['correlationid'];
      if (typeof id !== 'string' || !GUID.test(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, 5);

    const findings = [];
    for (const trace of picked) {
      const jobs = (
        await getJson<ODataCollection>(
          `asyncoperations?$select=correlationid,requestid,depth,operationtype,statuscode,_owningextensionid_value,_regardingobjectid_value,createdon,startedon,completedon&$filter=correlationid eq ${trace['correlationid']}`,
        )
      ).value;
      const job = jobs.find((j) => j['_owningextensionid_value'] === trace['pluginstepid']);
      const start = Date.parse(String(trace['performanceexecutionstarttime']));
      const withinJob =
        job && typeof job['startedon'] === 'string'
          ? start >= Date.parse(job['startedon']) - 1000 &&
            start <= (typeof job['completedon'] === 'string' ? Date.parse(job['completedon']) : Date.now()) + 1000
          : null;
      findings.push({
        typename: trace['typename'],
        traceDepth: trace['depth'],
        jobsWithSameCorrelation: jobs.length,
        stepJobFound: Boolean(job),
        jobDepth: job?.['depth'] ?? null,
        sameRequestId: job ? job['requestid'] === trace['requestid'] : null,
        traceStartWithinJobWindow: withinJob,
        jobStatus: job ? (formatted(job, 'statuscode') ?? job['statuscode']) : null,
        regardingTable: job ? (job['_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname'] ?? null) : null,
      });
    }
    const matched = findings.filter((f) => f.stepJobFound).length;
    return {
      status: matched > 0 ? 'pass' : 'warn',
      summary: `${matched}/${findings.length} async traces found their system job by correlationid + step${matched < findings.length ? ' (missing jobs may be auto-deleted on success)' : ''}`,
      details: findings,
    };
  });
}
