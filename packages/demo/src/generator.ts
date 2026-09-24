// Demo environment for a fictional insurer, "Harbor Insurance". Produces raw Web API rows (with
// formatted-value annotations and whole-second timestamps, like the real API), so demo mode runs
// the real mappers and sync engine.
//
// Scripted incidents, so every screen has something to show:
//   1. Normal policy saves: sync pipeline + async notify job + a nested account rollup on create.
//   2. A recursive contact ↔ account update loop that reaches depth 8 and fails.
//   3. PolicyErpSync (sync, calls an ERP) slows down after a "deployment" 5 days ago.
//   4. ClaimErpExport (async) sometimes fails and retries 3 times.
//   5. ContactAudit has no filtering attributes and runs on every contact update (noisy today).
//   6. PolicyValidate occasionally rejects a save (a sync failure that rolls back).
//   7. A custom workflow activity inside a background workflow job.
import { Rng } from './random.ts';

type Raw = Record<string, unknown>;

export interface DemoOptions {
  seed?: number;
  /** End of the generated history (epoch ms). Defaults to now. */
  now?: number;
  days?: number;
  /** Multiplies the number of operations (1 ≈ 1,000 operations per busy weekday). */
  scale?: number;
}

export interface DemoDataset {
  now: number;
  userId: string;
  organizationId: string;
  traceLogs: Raw[];
  asyncOperations: Raw[];
  steps: Raw[];
  organization: Raw;
  userRoles: Raw[];
}

const FV = '@OData.Community.Display.V1.FormattedValue';
const LT = '@Microsoft.Dynamics.CRM.lookuplogicalname';
const SYSTEM_ADMINISTRATOR_ROLE_TEMPLATE = '627090ff-40a3-4053-8790-584edc5be201';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The Web API returns whole seconds (spike S1), so the demo does too. */
const isoSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

interface StepDef {
  key: string;
  id: string;
  typeName: string;
  message: 'Create' | 'Update';
  table: string;
  stage: 10 | 20 | 40;
  mode: 0 | 1;
  rank: number;
  filtering: string | null;
  asyncAutoDelete?: boolean;
}

interface User {
  id: string;
  name: string;
}

interface Records {
  ids: string[];
  names: string[];
}

class Builder {
  readonly traceLogs: Raw[] = [];
  readonly jobs: Raw[] = [];
  readonly steps = new Map<string, StepDef>();
  readonly users: User[];
  readonly records: Record<string, Records> = {};
  readonly rng: Rng;
  readonly now: number;

  constructor(rng: Rng, now: number) {
    this.rng = rng;
    this.now = now;
    const defs: Array<Omit<StepDef, 'id'>> = [
      { key: 'policyValidate', typeName: 'Harbor.Plugins.PolicyValidate', message: 'Update', table: 'hbr_policy', stage: 10, mode: 0, rank: 1, filtering: 'hbr_premium,hbr_coverage' },
      { key: 'policyValidateCreate', typeName: 'Harbor.Plugins.PolicyValidate', message: 'Create', table: 'hbr_policy', stage: 10, mode: 0, rank: 1, filtering: null },
      { key: 'policyDefaults', typeName: 'Harbor.Plugins.PolicyDefaults', message: 'Create', table: 'hbr_policy', stage: 20, mode: 0, rank: 1, filtering: null },
      { key: 'policyPostCreate', typeName: 'Harbor.Plugins.PolicyPostCreate', message: 'Create', table: 'hbr_policy', stage: 40, mode: 0, rank: 1, filtering: null },
      { key: 'policyErpSync', typeName: 'Harbor.Plugins.PolicyErpSync', message: 'Update', table: 'hbr_policy', stage: 40, mode: 0, rank: 2, filtering: 'hbr_premium,hbr_status' },
      { key: 'policyNotify', typeName: 'Harbor.Plugins.PolicyNotify', message: 'Update', table: 'hbr_policy', stage: 40, mode: 1, rank: 1, filtering: 'hbr_status' },
      { key: 'accountRollup', typeName: 'Harbor.Plugins.AccountRollup', message: 'Update', table: 'account', stage: 40, mode: 0, rank: 1, filtering: 'hbr_totalpremium' },
      { key: 'claimNumbering', typeName: 'Harbor.Plugins.ClaimNumbering', message: 'Create', table: 'hbr_claim', stage: 20, mode: 0, rank: 1, filtering: null },
      { key: 'claimErpExport', typeName: 'Harbor.Plugins.ClaimErpExport', message: 'Create', table: 'hbr_claim', stage: 40, mode: 1, rank: 1, filtering: null },
      { key: 'contactAudit', typeName: 'Harbor.Plugins.ContactAudit', message: 'Update', table: 'contact', stage: 40, mode: 0, rank: 1, filtering: null },
      { key: 'contactSyncToAccount', typeName: 'Harbor.Plugins.ContactSyncToAccount', message: 'Update', table: 'contact', stage: 40, mode: 0, rank: 2, filtering: 'parentcustomerid,hbr_segment' },
      { key: 'accountContactCount', typeName: 'Harbor.Plugins.AccountContactCount', message: 'Update', table: 'account', stage: 40, mode: 0, rank: 2, filtering: null },
    ];
    for (const d of defs) this.steps.set(d.key, { ...d, id: rng.uuid() });
    this.users = ['Jamie Ortiz', 'Priya Raman', 'Sam Keller', 'Noor Haddad', 'Leo Brandt'].map((name) => ({ id: rng.uuid(), name }));
    const pool = (table: string, count: number, name: (i: number) => string) => {
      this.records[table] = { ids: Array.from({ length: count }, () => rng.uuid()), names: Array.from({ length: count }, (_, i) => name(i)) };
    };
    pool('hbr_policy', 400, (i) => `HP-${10_000 + i}`);
    pool('hbr_claim', 250, (i) => `CL-${20_000 + i}`);
    pool('account', 120, (i) => `${rng.pick(['Blue', 'North', 'Harbor', 'Summit', 'Pine', 'Coastal', 'Granite'])} ${rng.pick(['Logistics', 'Foods', 'Clinic', 'Studios', 'Marine', 'Builders'])} ${i}`);
    pool('contact', 300, () => `${rng.pick(['Alex', 'Mia', 'Ravi', 'Chen', 'Ola', 'Tom', 'Ines', 'Yusuf'])} ${rng.pick(['Berg', 'Silva', 'Novak', 'Okafor', 'Lind', 'Park', 'Mehta'])}`);
  }

  step(key: string): StepDef {
    return this.steps.get(key)!;
  }

  record(table: string): { id: string; name: string } {
    const pool = this.records[table]!;
    const i = this.rng.int(0, pool.ids.length - 1);
    return { id: pool.ids[i]!, name: pool.names[i]! };
  }

  traceLog(p: {
    step: StepDef | null;
    typeName?: string;
    operationType?: 1 | 2;
    correlationId: string;
    requestId: string;
    depth: number;
    start: number;
    durationMs: number;
    constructorMs?: number;
    user: User;
    exception?: string;
    lines: string[];
    mode?: 0 | 1;
    message?: string;
    table?: string;
  }): void {
    if (p.start > this.now) return;
    const mode = p.mode ?? p.step?.mode ?? 0;
    const operationType = p.operationType ?? 1;
    const created = p.start + p.durationMs + this.rng.int(3, 40);
    this.traceLogs.push({
      plugintracelogid: this.rng.uuid(),
      correlationid: p.correlationId,
      requestid: p.requestId,
      pluginstepid: p.step?.id ?? null,
      typename: p.typeName ?? p.step!.typeName,
      messagename: p.message ?? p.step!.message,
      primaryentity: p.table ?? p.step!.table,
      mode,
      [`mode${FV}`]: mode === 0 ? 'Synchronous' : 'Asynchronous',
      operationtype: operationType,
      [`operationtype${FV}`]: operationType === 1 ? 'Plug-in' : 'Workflow Activity',
      depth: p.depth,
      performanceexecutionstarttime: isoSeconds(p.start),
      performanceexecutionduration: p.durationMs,
      performanceconstructorduration: p.constructorMs ?? this.rng.int(0, 3),
      exceptiondetails: p.exception ?? null,
      messageblock: p.lines.join('\n'),
      createdon: isoSeconds(created),
      _createdby_value: p.user.id,
      [`_createdby_value${FV}`]: p.user.name,
      [`_createdby_value${LT}`]: 'systemuser',
    });
  }

  job(p: {
    name: string;
    operationType: 1 | 10;
    correlationId: string;
    requestId: string;
    depth: number;
    step: StepDef | null;
    regarding: { table: string; id: string; name: string };
    message: string;
    created: number;
    started: number | null;
    completed: number | null;
    statusCode: 10 | 20 | 30 | 31;
    retryCount?: number;
    friendlyMessage?: string;
  }): void {
    if (p.created > this.now) return;
    // Anything scheduled after "now" hasn't happened yet: the job is still waiting or running.
    const clamp = (t: number | null) => (t === null || t > this.now ? null : t);
    const started = clamp(p.started);
    const completed = started === null ? null : clamp(p.completed);
    let statusCode = p.statusCode;
    if (started === null) statusCode = 10;
    else if (completed === null) statusCode = 20;
    const labels = { 10: 'Waiting', 20: 'In Progress', 30: 'Succeeded', 31: 'Failed' } as const;
    this.jobs.push({
      asyncoperationid: this.rng.uuid(),
      name: p.name,
      correlationid: p.correlationId,
      requestid: p.requestId,
      operationtype: p.operationType,
      [`operationtype${FV}`]: p.operationType === 1 ? 'System Event' : 'Workflow',
      statuscode: statusCode,
      [`statuscode${FV}`]: labels[statusCode],
      depth: p.depth,
      _owningextensionid_value: p.step?.id ?? null,
      [`_owningextensionid_value${LT}`]: p.step ? 'sdkmessageprocessingstep' : null,
      _workflowactivationid_value: p.operationType === 10 ? WORKFLOW_ID : null,
      _regardingobjectid_value: p.regarding.id,
      [`_regardingobjectid_value${LT}`]: p.regarding.table,
      [`_regardingobjectid_value${FV}`]: p.regarding.name,
      primaryentitytype: p.regarding.table,
      messagename: p.message,
      createdon: isoSeconds(p.created),
      startedon: started === null ? null : isoSeconds(started),
      completedon: completed === null ? null : isoSeconds(completed),
      modifiedon: isoSeconds(completed ?? started ?? p.created),
      retrycount: p.retryCount ?? 0,
      errorcode: statusCode === 31 ? -2147204303 : null,
      friendlymessage: statusCode === 31 ? (p.friendlyMessage ?? null) : null,
      message: null,
    });
  }
}

const WORKFLOW_ID = '5b1f0e7a-3c2d-4e8f-9a61-0d7c2b4e9f13';

// ── scenarios ────────────────────────────────────────────────────────────────

interface OpContext {
  b: Builder;
  user: User;
  correlationId: string;
  daysAgo: number;
}

const enter = (typeName: string, ctx: OpContext, extra = '') =>
  `Entered ${typeName}.Execute(), Correlation Id: ${ctx.correlationId}, Initiating User: ${ctx.user.id}${extra}`;
const exit = (typeName: string) => `Exiting ${typeName}.Execute()`;

/** One step of a pipeline: runs at `at`, returns when it ended and whether it threw. */
type PipelineItem = (at: number, requestId: string) => { end: number; failed?: boolean };

/** Runs steps of one pipeline in order; returns the end time. */
function pipeline(ctx: OpContext, depth: number, start: number, items: PipelineItem[]): { end: number; requestId: string; failed: boolean } {
  const requestId = ctx.b.rng.uuid();
  let cursor = start;
  for (const item of items) {
    const r = item(cursor + ctx.b.rng.int(1, 6), requestId);
    cursor = r.end;
    if (r.failed) return { end: cursor, requestId, failed: true };
  }
  return { end: cursor, requestId, failed: false };
}

function simpleStep(ctx: OpContext, step: StepDef, depth: number, medianMs: number, lines: string[], opts: { exception?: string; constructorMs?: number } = {}): PipelineItem {
  return (at, requestId) => {
    const durationMs = ctx.b.rng.duration(medianMs, 0.45);
    ctx.b.traceLog({
      step,
      correlationId: ctx.correlationId,
      requestId,
      depth,
      start: at,
      durationMs,
      user: ctx.user,
      lines: [enter(step.typeName, ctx), ...lines, opts.exception ? 'Throwing InvalidPluginExecutionException' : exit(step.typeName)],
      ...(opts.exception ? { exception: opts.exception } : {}),
      ...(opts.constructorMs !== undefined ? { constructorMs: opts.constructorMs } : {}),
    });
    return { end: at + durationMs, failed: Boolean(opts.exception) };
  };
}

function validationFault(message: string): string {
  return `Unhandled exception:
Exception type: System.ServiceModel.FaultException\`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]
Message: ${message}
Detail:
<OrganizationServiceFault xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.microsoft.com/xrm/2011/Contracts">
  <ErrorCode>-2147220891</ErrorCode>
  <HelpLink i:nil="true" />
  <Message>${message}</Message>
  <InnerFault i:nil="true" />
  <OriginalException>PluginExecution</OriginalException>
</OrganizationServiceFault>`;
}

function asyncPluginJob(ctx: OpContext, step: StepDef, queuedAt: number, requestId: string, regarding: { table: string; id: string; name: string }, run: { medianMs: number; lines: string[] }) {
  const { b } = ctx;
  const started = queuedAt + b.rng.duration(2500, 0.8, 300);
  const durationMs = b.rng.duration(run.medianMs, 0.4);
  b.traceLog({ step, correlationId: ctx.correlationId, requestId: b.rng.uuid(), depth: 1, start: started + b.rng.int(20, 120), durationMs, user: ctx.user, lines: [enter(step.typeName, ctx), ...run.lines, exit(step.typeName)] });
  b.job({
    name: `${step.typeName}: ${step.message} of ${step.table}`,
    operationType: 1,
    correlationId: ctx.correlationId,
    requestId,
    depth: 1,
    step,
    regarding,
    message: step.message,
    created: queuedAt,
    started,
    completed: started + durationMs + b.rng.int(150, 400),
    statusCode: 30,
  });
}

function policyUpdate(ctx: OpContext, t: number): void {
  const { b } = ctx;
  const policy = b.record('hbr_policy');
  const validate = b.step('policyValidate');
  const erp = b.step('policyErpSync');
  const reject = b.rng.chance(0.012);
  const slow = ctx.daysAgo < 5; // the "deployment" 5 days ago made the ERP call slower
  const erpMs = slow ? b.rng.duration(1500, 0.55) : b.rng.duration(420, 0.45);
  const r = pipeline(ctx, 1, t, [
    simpleStep(ctx, validate, 1, 14, [`Validating ${policy.name}`, reject ? 'Premium -120.00 is not allowed' : 'Premium and coverage OK'], reject ? { exception: validationFault('The policy premium must be positive.') } : {}),
    (at, requestId) => {
      b.traceLog({
        step: erp,
        correlationId: ctx.correlationId,
        requestId,
        depth: 1,
        start: at,
        durationMs: erpMs,
        constructorMs: b.rng.int(35, 90),
        user: ctx.user,
        lines: [
          enter(erp.typeName, ctx),
          'Loading ERP endpoint from secure configuration',
          `POST https://erp.harbor.example/api/policies/${policy.name}`,
          `{"policy":"${policy.name}","status":"Active","premium":${b.rng.int(400, 9000)}.00}`,
          `ERP responded 200 in ${erpMs - b.rng.int(5, 30)} ms${slow ? ' (retry-after header honoured once)' : ''}`,
          exit(erp.typeName),
        ],
      });
      return { end: at + erpMs };
    },
  ]);
  if (r.failed) return;
  if (b.rng.chance(0.6)) {
    asyncPluginJob(ctx, b.step('policyNotify'), r.end + b.rng.int(5, 30), r.requestId, { table: 'hbr_policy', ...policy }, {
      medianMs: 180,
      lines: [`Status changed for ${policy.name}`, 'Queued email to the policy owner'],
    });
  }
}

function policyCreate(ctx: OpContext, t: number): void {
  const { b } = ctx;
  const policy = b.record('hbr_policy');
  const account = b.record('account');
  const post = b.step('policyPostCreate');
  const r = pipeline(ctx, 1, t, [
    simpleStep(ctx, b.step('policyValidateCreate'), 1, 12, ['New policy: checking required fields']),
    simpleStep(ctx, b.step('policyDefaults'), 1, 8, ['Defaulting currency and renewal date']),
    (at, requestId) => {
      // PostCreate updates the account, which runs AccountRollup at depth 2 inside PostCreate's window.
      const before = b.rng.duration(45, 0.4);
      const nested = pipeline(ctx, 2, at + before, [simpleStep(ctx, b.step('accountRollup'), 2, 38, [`Recalculating total premium for ${account.name}`])]);
      const after = b.rng.duration(25, 0.4);
      const durationMs = nested.end - at + after;
      b.traceLog({
        step: post,
        correlationId: ctx.correlationId,
        requestId,
        depth: 1,
        start: at,
        durationMs,
        user: ctx.user,
        lines: [enter(post.typeName, ctx), `Linking ${policy.name} to ${account.name}`, 'Updating account hbr_totalpremium', exit(post.typeName)],
      });
      return { end: at + durationMs };
    },
  ]);
  // A background workflow with a custom workflow activity.
  const queued = r.end + b.rng.int(10, 40);
  const started = queued + b.rng.duration(4000, 0.7, 500);
  const activityMs = b.rng.duration(260, 0.5);
  b.traceLog({
    step: null,
    typeName: 'Harbor.Workflows.CalculateRisk',
    operationType: 2,
    mode: 1,
    message: 'Create',
    table: 'hbr_policy',
    correlationId: ctx.correlationId,
    requestId: b.rng.uuid(),
    depth: 1,
    start: started + b.rng.int(50, 200),
    durationMs: activityMs,
    user: ctx.user,
    lines: ['CalculateRisk activity started', `Risk score for ${policy.name}: ${b.rng.int(12, 97)}`],
  });
  b.job({
    name: 'Calculate policy risk',
    operationType: 10,
    correlationId: ctx.correlationId,
    requestId: r.requestId,
    depth: 1,
    step: null,
    regarding: { table: 'hbr_policy', ...policy },
    message: 'Create',
    created: queued,
    started,
    completed: started + activityMs + b.rng.int(200, 600),
    statusCode: 30,
  });
}

function claimCreate(ctx: OpContext, t: number): void {
  const { b } = ctx;
  const claim = b.record('hbr_claim');
  const r = pipeline(ctx, 1, t, [simpleStep(ctx, b.step('claimNumbering'), 1, 9, [`Assigned claim number ${claim.name}`])]);
  const step = b.step('claimErpExport');
  const queued = r.end + b.rng.int(5, 30);
  const started = queued + b.rng.duration(3000, 0.8, 300);
  if (!b.rng.chance(0.07)) {
    const durationMs = b.rng.duration(650, 0.5);
    b.traceLog({ step, correlationId: ctx.correlationId, requestId: b.rng.uuid(), depth: 1, start: started + 60, durationMs, user: ctx.user, lines: [enter(step.typeName, ctx), `Exported ${claim.name} to ERP`, exit(step.typeName)] });
    b.job({ name: `${step.typeName}: Create of hbr_claim`, operationType: 1, correlationId: ctx.correlationId, requestId: r.requestId, depth: 1, step, regarding: { table: 'hbr_claim', ...claim }, message: 'Create', created: queued, started, completed: started + durationMs + 250, statusCode: 30 });
    return;
  }
  // Failing export: 4 attempts (the first plus 3 retries), minutes apart.
  let attemptStart = started;
  const error = `System.InvalidOperationException: ERP export failed for ${claim.name} ---> System.Net.WebException: The remote server returned an error: (503) Server Unavailable.
   at System.Net.HttpWebRequest.GetResponse()
   at Harbor.Plugins.ErpClient.Post(String path, String body) in C:\\build\\Harbor.Plugins\\ErpClient.cs:line 57
   --- End of inner exception stack trace ---
   at Harbor.Plugins.ClaimErpExport.Execute(IServiceProvider serviceProvider) in C:\\build\\Harbor.Plugins\\ClaimErpExport.cs:line 34
   at Microsoft.Crm.Sandbox.SandboxCodeUnit.Execute(IExecutionContext context)`;
  let end = attemptStart;
  for (let attempt = 0; attempt < 4; attempt++) {
    const durationMs = b.rng.duration(30_000, 0.1); // timeouts
    b.traceLog({
      step,
      correlationId: ctx.correlationId,
      requestId: b.rng.uuid(),
      depth: 1,
      start: attemptStart,
      durationMs,
      user: ctx.user,
      lines: [enter(step.typeName, ctx, `, Attempt: ${attempt + 1}`), `POST https://erp.harbor.example/api/claims/${claim.name}`, 'Waiting for ERP…', 'ERP returned 503'],
      exception: error,
    });
    end = attemptStart + durationMs;
    attemptStart = end + b.rng.int(60_000, 240_000);
  }
  b.job({
    name: `${step.typeName}: Create of hbr_claim`,
    operationType: 1,
    correlationId: ctx.correlationId,
    requestId: r.requestId,
    depth: 1,
    step,
    regarding: { table: 'hbr_claim', ...claim },
    message: 'Create',
    created: queued,
    started,
    completed: end + 300,
    statusCode: 31,
    retryCount: 3,
    friendlyMessage: `ERP export failed for ${claim.name}: the remote server returned (503) Server Unavailable.`,
  });
}

function contactUpdate(ctx: OpContext, t: number): void {
  const { b } = ctx;
  const contact = b.record('contact');
  const items: PipelineItem[] = [simpleStep(ctx, b.step('contactAudit'), 1, 9, [`Audit snapshot for ${contact.name}`, 'Changed columns: (all columns: no filtering attributes)'])];
  if (b.rng.chance(0.12)) {
    const account = b.record('account');
    const sync = b.step('contactSyncToAccount');
    items.push((at, requestId) => {
      const nested = pipeline(ctx, 2, at + b.rng.duration(20, 0.3), [simpleStep(ctx, b.step('accountContactCount'), 2, 30, [`Counting contacts of ${account.name}`])]);
      const durationMs = nested.end - at + b.rng.duration(10, 0.3);
      b.traceLog({ step: sync, correlationId: ctx.correlationId, requestId, depth: 1, start: at, durationMs, user: ctx.user, lines: [enter(sync.typeName, ctx), `Copying segment to ${account.name}`, exit(sync.typeName)] });
      return { end: at + durationMs };
    });
  }
  pipeline(ctx, 1, t, items);
}

/** Contact → account → contact → … until the recursion guard trips at depth 8. */
function updateLoop(ctx: OpContext, t: number): void {
  const { b } = ctx;
  const contact = b.record('contact');
  const account = b.record('account');
  const MAX = 8;
  const guard = `Harbor.Plugins.RecursionGuardException: Recursive update detected: depth ${MAX} reached for contact ${contact.name}
   at Harbor.Plugins.ContactSyncToAccount.Execute(IServiceProvider serviceProvider) in C:\\build\\Harbor.Plugins\\ContactSyncToAccount.cs:line 21`;
  // Builds the request at `depth` starting at `at`; returns its end time.
  const level = (depth: number, at: number): number => {
    const onContact = depth % 2 === 1;
    const requestId = b.rng.uuid();
    if (onContact) {
      const audit = b.step('contactAudit');
      const auditMs = b.rng.duration(9, 0.3);
      b.traceLog({ step: audit, correlationId: ctx.correlationId, requestId, depth, start: at, durationMs: auditMs, user: ctx.user, lines: [enter(audit.typeName, ctx), exit(audit.typeName)] });
      const sync = b.step('contactSyncToAccount');
      const syncStart = at + auditMs + 2;
      if (depth >= MAX) {
        const failMs = b.rng.duration(6, 0.2);
        b.traceLog({ step: sync, correlationId: ctx.correlationId, requestId, depth, start: syncStart, durationMs: failMs, user: ctx.user, lines: [enter(sync.typeName, ctx), `Depth ${depth}: refusing to continue`], exception: guard });
        return syncStart + failMs;
      }
      const inner = level(depth + 1, syncStart + b.rng.duration(12, 0.3));
      const durationMs = inner - syncStart + b.rng.duration(6, 0.3);
      b.traceLog({ step: sync, correlationId: ctx.correlationId, requestId, depth, start: syncStart, durationMs, user: ctx.user, lines: [enter(sync.typeName, ctx), `Depth ${depth}: copying segment to ${account.name}`, `Depth ${depth}: updating account`], exception: guard });
      return syncStart + durationMs;
    }
    const count = b.step('accountContactCount');
    if (depth >= MAX) {
      const failMs = b.rng.duration(6, 0.2);
      b.traceLog({ step: count, correlationId: ctx.correlationId, requestId, depth, start: at, durationMs: failMs, user: ctx.user, lines: [enter(count.typeName, ctx), `Depth ${depth}: refusing to continue`], exception: guard });
      return at + failMs;
    }
    const inner = level(depth + 1, at + b.rng.duration(15, 0.3));
    const durationMs = inner - at + b.rng.duration(5, 0.3);
    b.traceLog({ step: count, correlationId: ctx.correlationId, requestId, depth, start: at, durationMs, user: ctx.user, lines: [enter(count.typeName, ctx), `Depth ${depth}: touching contacts of ${account.name}`], exception: guard });
    return at + durationMs;
  };
  level(1, t);
}

// ── volume ───────────────────────────────────────────────────────────────────

/** Relative activity per local hour of a weekday (office hours, lunch dip). */
const HOURLY = [0.05, 0.03, 0.03, 0.03, 0.05, 0.1, 0.25, 0.6, 1.0, 1.1, 1.05, 0.95, 0.6, 0.85, 1.0, 1.0, 0.9, 0.7, 0.4, 0.25, 0.18, 0.12, 0.08, 0.06];

export function generateDemo(options: DemoOptions = {}): DemoDataset {
  const rng = new Rng(options.seed ?? 20260924);
  const now = options.now ?? Date.now();
  const days = options.days ?? 14;
  const scale = options.scale ?? 1;
  const b = new Builder(rng, now);
  const perBusyHour = 90 * scale;

  const firstHour = Math.floor((now - days * DAY) / HOUR) * HOUR;
  for (let hourStart = firstHour; hourStart <= now; hourStart += HOUR) {
    const date = new Date(hourStart);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const daysAgo = Math.floor((now - hourStart) / DAY);
    const mean = perBusyHour * HOURLY[date.getHours()]! * (weekend ? 0.2 : 1);
    const count = Math.max(0, Math.round(mean * (0.8 + 0.4 * rng.next())));
    for (let i = 0; i < count; i++) {
      const t = hourStart + Math.floor(rng.next() * HOUR);
      const ctx: OpContext = { b, user: rng.pick(b.users), correlationId: rng.uuid(), daysAgo };
      const roll = rng.next();
      // The noisy ContactAudit step shows up more in the last 24 hours.
      const contactShare = daysAgo === 0 ? 0.55 : 0.4;
      if (roll < contactShare) contactUpdate(ctx, t);
      else if (roll < contactShare + 0.33) policyUpdate(ctx, t);
      else if (roll < contactShare + 0.45) policyCreate(ctx, t);
      else claimCreate(ctx, t);
    }
  }
  // Two loop incidents: one 3 days ago, one this morning.
  for (const ago of [3 * DAY + 2 * HOUR, 5 * HOUR]) {
    const t = now - ago;
    if (t > now - days * DAY) updateLoop({ b, user: b.users[1]!, correlationId: rng.uuid(), daysAgo: Math.floor(ago / DAY) }, t);
  }

  const steps: Raw[] = [...b.steps.values()].map((s) => ({
    sdkmessageprocessingstepid: s.id,
    name: `${s.typeName}: ${s.message} of ${s.table}`,
    stage: s.stage,
    [`stage${FV}`]: { 10: 'Pre-validation', 20: 'Pre-operation', 40: 'Post-operation' }[s.stage],
    mode: s.mode,
    [`mode${FV}`]: s.mode === 0 ? 'Synchronous' : 'Asynchronous',
    rank: s.rank,
    filteringattributes: s.filtering,
    statecode: 0,
    asyncautodelete: s.asyncAutoDelete ?? false,
    ismanaged: false,
    _impersonatinguserid_value: null,
    sdkmessageid: { name: s.message },
    sdkmessagefilterid: { primaryobjecttypecode: s.table },
    plugintypeid: { typename: s.typeName, assemblyname: 'Harbor.Plugins' },
  }));

  const byCreated = (column: string) => (x: Raw, y: Raw) => String(x[column]).localeCompare(String(y[column]));
  return {
    now,
    userId: b.users[0]!.id,
    organizationId: '0f5c2a1e-7b3d-4c9e-8a21-6d4f0b9c3e71',
    traceLogs: b.traceLogs.sort(byCreated('createdon')),
    asyncOperations: b.jobs.sort(byCreated('modifiedon')),
    steps,
    organization: {
      organizationid: '0f5c2a1e-7b3d-4c9e-8a21-6d4f0b9c3e71',
      plugintracelogsetting: 2,
      [`plugintracelogsetting${FV}`]: 'All',
      isauditenabled: false,
      maxuploadfilesize: 5_242_880,
    },
    userRoles: [{ roleid: '8a0d9c21-4b6e-4f7a-9d3c-2e1f5a7b9c04', _roletemplateid_value: SYSTEM_ADMINISTRATOR_ROLE_TEMPLATE }],
  };
}
