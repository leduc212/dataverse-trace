import { formatted, getJson, hasFractionalSeconds, type ODataCollection } from './api.ts';
import { check, type CheckResult, type CheckOutcome } from './types.ts';

type Row = Record<string, unknown>;

export interface RunContext {
  userId?: string;
  /** Display names seen in results, masked in the exported JSON. */
  personalNames: Set<string>;
}

const JS_MIME = /^(text|application)\/(x-)?(javascript|ecmascript)\b/i;
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
