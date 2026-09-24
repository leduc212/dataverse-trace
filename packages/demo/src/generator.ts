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
// v0.2, the record story:
//   - Every committed save is audited (with old and new values); plugin steps run only when their
//     filtering attributes changed, so expected vs. actual has real answers.
//   - Cloud flows with real trigger definitions: "Notify underwriter" (status changes of policies
//     over 1,000), "Welcome pack" (+ a child flow), "Claim triage" (some runs fail), "Sync account
//     to marketing" (name/phone only, so the rollup on policy create never starts it), and an
//     inactive legacy flow.
//   - A burst of three status changes within two seconds (ambiguous flow matches).
//   - One flow-run ingestion event (a gap in run history).
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
  seed: number;
  userId: string;
  organizationId: string;
  traceLogs: Raw[];
  asyncOperations: Raw[];
  steps: Raw[];
  organization: Raw;
  userRoles: Raw[];
  /** Audit rows of every save that committed. */
  audits: Raw[];
  /** RetrieveAuditDetails responses by audit id. */
  auditDetails: Record<string, Raw>;
  flowRuns: Raw[];
  flowEvents: Raw[];
  /** workflow rows: classic workflows, a business rule and cloud flows (with clientdata). */
  workflows: Raw[];
  /** Live trigger subscriptions of the active cloud flows. */
  callbackRegistrations: Raw[];
  /** Current values of every record, by table then id (primary id and name included). */
  records: Record<string, Record<string, Raw>>;
  /** Table metadata, as EntityDefinitions returns it. */
  entities: Record<string, { LogicalName: string; EntitySetName: string; PrimaryIdAttribute: string; PrimaryNameAttribute: string }>;
  /** Ground truth for tests: the save that triggered each top-level flow run (by flowrunid). */
  truth: { flowRunSaves: Record<string, { table: string; recordId: string; time: number }> };
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

/** A cloud flow with a Dataverse row trigger (message: 1 added, 3 modified; 0 = child flow, no trigger). */
interface FlowDef {
  key: string;
  id: string;
  name: string;
  table: string;
  message: 0 | 1 | 3;
  filtering: string | null;
  filter: string | null;
  active: boolean;
  medianMs: number;
  failRate: number;
}

const ENTITIES: DemoDataset['entities'] = {
  hbr_policy: { LogicalName: 'hbr_policy', EntitySetName: 'hbr_policies', PrimaryIdAttribute: 'hbr_policyid', PrimaryNameAttribute: 'hbr_name' },
  hbr_claim: { LogicalName: 'hbr_claim', EntitySetName: 'hbr_claims', PrimaryIdAttribute: 'hbr_claimid', PrimaryNameAttribute: 'hbr_name' },
  account: { LogicalName: 'account', EntitySetName: 'accounts', PrimaryIdAttribute: 'accountid', PrimaryNameAttribute: 'name' },
  contact: { LogicalName: 'contact', EntitySetName: 'contacts', PrimaryIdAttribute: 'contactid', PrimaryNameAttribute: 'fullname' },
};

interface Records {
  ids: string[];
  names: string[];
}

class Builder {
  readonly traceLogs: Raw[] = [];
  readonly jobs: Raw[] = [];
  readonly audits: Raw[] = [];
  readonly auditDetails: Record<string, Raw> = {};
  readonly flowRuns: Raw[] = [];
  readonly flows = new Map<string, FlowDef>();
  /** Current column values per `table:id`, updated by every committed save. */
  readonly values = new Map<string, Raw>();
  readonly truth: DemoDataset['truth'] = { flowRunSaves: {} };
  /** Fixed delay before a flow run's row is written (simulated saves); otherwise 30 s – 5 min. */
  flowWriteDelayMs: number | null = null;
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

    const flows: Array<Omit<FlowDef, 'id'>> = [
      { key: 'notify', name: 'Notify underwriter on status change', table: 'hbr_policy', message: 3, filtering: 'hbr_status', filter: 'hbr_premium gt 1000', active: true, medianMs: 9000, failRate: 0.03 },
      { key: 'welcome', name: 'Welcome pack for new policy', table: 'hbr_policy', message: 1, filtering: null, filter: null, active: true, medianMs: 14_000, failRate: 0.02 },
      { key: 'pdf', name: 'Generate policy PDF', table: 'hbr_policy', message: 0, filtering: null, filter: null, active: true, medianMs: 6000, failRate: 0.01 },
      { key: 'marketing', name: 'Sync account to marketing', table: 'account', message: 3, filtering: 'name,telephone1', filter: null, active: true, medianMs: 4000, failRate: 0.01 },
      { key: 'triage', name: 'Claim triage', table: 'hbr_claim', message: 1, filtering: null, filter: null, active: true, medianMs: 20_000, failRate: 0.06 },
      { key: 'renewal', name: 'Legacy renewal reminder', table: 'hbr_policy', message: 3, filtering: 'hbr_status', filter: null, active: false, medianMs: 5000, failRate: 0 },
    ];
    for (const f of flows) this.flows.set(f.key, { ...f, id: rng.uuid() });

    for (const [table, records] of Object.entries(this.records)) {
      records.ids.forEach((id, i) => {
        const name = records.names[i]!;
        const values: Raw =
          table === 'hbr_policy'
            ? { hbr_name: name, hbr_premium: rng.int(300, 9000), hbr_status: rng.pick([1, 1, 2, 3]), hbr_coverage: rng.pick(['Basic', 'Plus', 'Premium']), hbr_description: null }
            : table === 'hbr_claim'
              ? { hbr_name: name, hbr_amount: rng.int(200, 40_000), hbr_status: 1 }
              : table === 'account'
                ? { name, telephone1: `+1 555 0${rng.int(100, 999)}`, hbr_totalpremium: rng.int(1000, 90_000), hbr_segment: rng.pick(['SMB', 'Mid', 'Enterprise']) }
                : { fullname: name, jobtitle: rng.pick(['Owner', 'CFO', 'Office manager', 'Buyer']), telephone1: `+1 555 1${rng.int(100, 999)}`, hbr_segment: rng.pick(['SMB', 'Mid', 'Enterprise']) };
        this.values.set(`${table}:${id}`, values);
      });
    }
  }

  value(table: string, id: string, column: string): unknown {
    return this.values.get(`${table}:${id}`)?.[column];
  }

  /**
   * A committed save: writes the audit row and its details, and updates the record's values.
   * Saves that roll back (a sync plugin threw) are never audited, like the real platform.
   */
  audit(p: { table: string; record: { id: string; name: string }; operation: 1 | 2; at: number; user: User; changes: Raw; transactionId?: string }): string {
    const transactionId = p.transactionId ?? this.rng.uuid();
    if (p.at > this.now) return transactionId;
    const key = `${p.table}:${p.record.id}`;
    const current = this.values.get(key) ?? {};
    const old: Raw = {};
    for (const column of Object.keys(p.changes)) old[column] = current[column] ?? null;
    this.values.set(key, { ...current, ...p.changes });
    const id = this.rng.uuid();
    const label = p.operation === 1 ? 'Create' : 'Update';
    this.audits.push({
      auditid: id,
      action: p.operation,
      [`action${FV}`]: label,
      operation: p.operation,
      [`operation${FV}`]: label,
      createdon: isoSeconds(p.at),
      _userid_value: p.user.id,
      [`_userid_value${FV}`]: p.user.name,
      transactionid: transactionId,
      _objectid_value: p.record.id,
      [`_objectid_value${LT}`]: p.table,
      [`_objectid_value${FV}`]: p.record.name,
      objecttypecode: p.table,
    });
    const type = `#Microsoft.Dynamics.CRM.${p.table}`;
    this.auditDetails[id] = {
      AuditDetail: {
        '@odata.type': '#Microsoft.Dynamics.CRM.AttributeAuditDetail',
        OldValue: p.operation === 1 ? { '@odata.type': type } : { '@odata.type': type, ...old },
        NewValue: { '@odata.type': type, ...p.changes },
      },
    };
    return transactionId;
  }

  /**
   * A cloud flow run that starts 1–60 s after `triggeredAt`. Run history is written to Dataverse
   * 30 s to 5 min after the run ends (spike S4), so recent runs may not exist yet.
   * Returns the run's name (its run id) and start, or null when it hasn't started by "now".
   */
  flowRun(p: { flow: string; triggeredAt: number; save?: { table: string; recordId: string }; parentRunId?: string; delayMs?: number }): { runId: string; start: number } | null {
    const flow = this.flows.get(p.flow)!;
    const start = p.triggeredAt + (p.delayMs ?? Math.min(60_000, this.rng.duration(6000, 0.8, 1000)));
    if (start > this.now) return null;
    const durationMs = this.rng.duration(flow.medianMs, 0.5, 400);
    const end = start + durationMs;
    const running = end > this.now;
    const written = this.flowWriteDelayMs !== null ? end + this.flowWriteDelayMs : running ? start + this.rng.int(5_000, 20_000) : end + this.rng.duration(60_000, 0.7, 30_000);
    const runId = `08584${this.rng.int(100_000_000, 999_999_999)}${this.rng.int(100_000, 999_999)}CU${this.rng.int(10, 99)}`;
    if (written > this.now) return { runId, start };
    const failed = !running && this.rng.chance(flow.failRate);
    const id = this.rng.uuid();
    this.flowRuns.push({
      flowrunid: id,
      name: runId,
      starttime: isoSeconds(start),
      endtime: running ? null : isoSeconds(end),
      duration: running ? null : durationMs,
      status: running ? 'Running' : failed ? 'Failed' : 'Succeeded',
      triggertype: p.parentRunId ? 'Manual' : 'Automated',
      errorcode: failed ? 'ActionFailed' : null,
      errormessage: failed ? `An action failed. No dependent actions succeeded.` : null,
      parentrunid: p.parentRunId ?? null,
      workflowid: flow.id,
      _workflow_value: flow.id,
      [`_workflow_value${FV}`]: flow.name,
      [`_workflow_value${LT}`]: 'workflow',
      createdon: isoSeconds(written),
      modifiedon: isoSeconds(written),
      _ownerid_value: this.users[0]!.id,
      [`_ownerid_value${FV}`]: this.users[0]!.name,
    });
    if (p.save && !p.parentRunId) this.truth.flowRunSaves[id] = { table: p.save.table, recordId: p.save.recordId, time: p.triggeredAt };
    return { runId, start };
  }

  step(key: string): StepDef {
    return this.steps.get(key)!;
  }

  /** An existing record. A few "busy" records get a third of the edits, so they have long stories. */
  record(table: string): { id: string; name: string } {
    const pool = this.records[table]!;
    const i = this.rng.chance(0.33) ? this.rng.int(0, 11) : this.rng.int(0, pool.ids.length - 1);
    return { id: pool.ids[i]!, name: pool.names[i]! };
  }

  /** A new record (for creates); later edits can pick it. */
  newRecord(table: string, values: Raw): { id: string; name: string } {
    const pool = this.records[table]!;
    const id = this.rng.uuid();
    const name = table === 'hbr_policy' ? `HP-${10_000 + pool.ids.length}` : `CL-${20_000 + pool.ids.length}`;
    pool.ids.push(id);
    pool.names.push(name);
    this.values.set(`${table}:${id}`, { ...values, hbr_name: name });
    return { id, name };
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

/** The activation of the "Calculate policy risk" background workflow (system jobs point at it). */
const WORKFLOW_ID = '5b1f0e7a-3c2d-4e8f-9a61-0d7c2b4e9f13';
const WORKFLOW_DEFINITION_ID = '3e9a4c1b-8d2f-4a6e-b1c7-5f0d2e8a9b36';
const BUSINESS_RULE_ID = '7c2e5a9d-1b4f-4e8a-a3d6-9f1b0c7e2d58';

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

/** Which columns a user changes when editing a policy. */
function policyChanges(b: Builder, policy: { id: string }): Raw {
  const roll = b.rng.next();
  const premium = () => Math.max(100, Math.round(Number(b.value('hbr_policy', policy.id, 'hbr_premium') ?? 1000) * (0.8 + 0.5 * b.rng.next())));
  const status = () => {
    const current = b.value('hbr_policy', policy.id, 'hbr_status');
    return b.rng.pick([1, 2, 3].filter((s) => s !== current));
  };
  if (roll < 0.35) return { hbr_status: status() };
  if (roll < 0.6) return { hbr_premium: premium() };
  if (roll < 0.75) return { hbr_premium: premium(), hbr_status: status() };
  if (roll < 0.87) return { hbr_coverage: b.rng.pick(['Basic', 'Plus', 'Premium']) };
  return { hbr_description: b.rng.pick(['Broker called about renewal', 'Customer asked for a copy', 'Updated after site visit']) };
}

/**
 * A user edits a policy. Plugin steps run only when their filtering attributes changed; the save
 * is audited when it commits; status changes start the "Notify underwriter" flow when the premium
 * is over 1,000 (its trigger's filter expression).
 */
function policyUpdate(ctx: OpContext, t: number, fixed?: { policy: { id: string; name: string }; changes: Raw; flowDelayMs?: number }): void {
  const { b } = ctx;
  const policy = fixed?.policy ?? b.record('hbr_policy');
  const changes = fixed?.changes ?? policyChanges(b, policy);
  const changed = (column: string) => column in changes;
  const validate = b.step('policyValidate');
  const erp = b.step('policyErpSync');
  const reject = !fixed && b.rng.chance(0.03);
  const slow = ctx.daysAgo < 5; // the "deployment" 5 days ago made the ERP call slower
  const erpMs = slow ? b.rng.duration(1500, 0.55) : b.rng.duration(420, 0.45);
  const items: PipelineItem[] = [];
  if (changed('hbr_premium') || changed('hbr_coverage')) {
    items.push(simpleStep(ctx, validate, 1, 14, [`Validating ${policy.name}`, reject ? 'Premium -120.00 is not allowed' : 'Premium and coverage OK'], reject ? { exception: validationFault('The policy premium must be positive.') } : {}));
  }
  if (changed('hbr_premium') || changed('hbr_status')) {
    items.push((at, requestId) => {
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
          `{"policy":"${policy.name}","status":${changes['hbr_status'] ?? b.value('hbr_policy', policy.id, 'hbr_status')},"premium":${changes['hbr_premium'] ?? b.value('hbr_policy', policy.id, 'hbr_premium')}.00}`,
          `ERP responded 200 in ${erpMs - b.rng.int(5, 30)} ms${slow ? ' (retry-after header honoured once)' : ''}`,
          exit(erp.typeName),
        ],
      });
      return { end: at + erpMs };
    });
  }
  const r = pipeline(ctx, 1, t, items);
  if (r.failed) return; // rolled back: no audit, no async work, no flows
  const commit = r.end + b.rng.int(2, 15);
  b.audit({ table: 'hbr_policy', record: policy, operation: 2, at: commit, user: ctx.user, changes });
  if (changed('hbr_status')) {
    asyncPluginJob(ctx, b.step('policyNotify'), r.end + b.rng.int(5, 30), r.requestId, { table: 'hbr_policy', ...policy }, {
      medianMs: 180,
      lines: [`Status changed for ${policy.name}`, 'Queued email to the policy owner'],
    });
    if (Number(b.value('hbr_policy', policy.id, 'hbr_premium')) > 1000) {
      b.flowRun({ flow: 'notify', triggeredAt: commit, save: { table: 'hbr_policy', recordId: policy.id }, ...(fixed?.flowDelayMs !== undefined ? { delayMs: fixed.flowDelayMs } : {}) });
    }
  }
}

function policyCreate(ctx: OpContext, t: number): void {
  const { b } = ctx;
  const values: Raw = { hbr_premium: b.rng.int(300, 9000), hbr_status: 1, hbr_coverage: b.rng.pick(['Basic', 'Plus', 'Premium']), hbr_description: null };
  const policy = b.newRecord('hbr_policy', values);
  const account = b.record('account');
  const post = b.step('policyPostCreate');
  const r = pipeline(ctx, 1, t, [
    simpleStep(ctx, b.step('policyValidateCreate'), 1, 12, ['New policy: checking required fields']),
    simpleStep(ctx, b.step('policyDefaults'), 1, 8, ['Defaulting currency and renewal date']),
    (at, requestId) => {
      // PostCreate updates the account, which runs AccountRollup at depth 2 inside PostCreate's window.
      const before = b.rng.duration(45, 0.4);
      const nested = pipeline(ctx, 2, at + before, [
        simpleStep(ctx, b.step('accountRollup'), 2, 38, [`Recalculating total premium for ${account.name}`]),
        simpleStep(ctx, b.step('accountContactCount'), 2, 24, [`Counting contacts of ${account.name}`]),
      ]);
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
  // One transaction: the policy create and PostCreate's account update commit together. The
  // account's "Sync account to marketing" flow filters on name and phone, so the rollup doesn't
  // start it (scenario 6: expected vs. actual explains why).
  const commit = r.end + b.rng.int(2, 15);
  const transactionId = b.audit({ table: 'hbr_policy', record: policy, operation: 1, at: commit, user: ctx.user, changes: b.values.get(`hbr_policy:${policy.id}`)! });
  const total = Number(b.value('account', account.id, 'hbr_totalpremium') ?? 0) + Number(values['hbr_premium']);
  b.audit({ table: 'account', record: account, operation: 2, at: commit, user: ctx.user, changes: { hbr_totalpremium: total }, transactionId });
  const welcome = b.flowRun({ flow: 'welcome', triggeredAt: commit, save: { table: 'hbr_policy', recordId: policy.id } });
  if (welcome) b.flowRun({ flow: 'pdf', triggeredAt: welcome.start, parentRunId: welcome.runId, delayMs: b.rng.int(2000, 6000) });
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
  const claim = b.newRecord('hbr_claim', { hbr_amount: b.rng.int(200, 40_000), hbr_status: 1 });
  const r = pipeline(ctx, 1, t, [simpleStep(ctx, b.step('claimNumbering'), 1, 9, [`Assigned claim number ${claim.name}`])]);
  const commit = r.end + b.rng.int(2, 15);
  b.audit({ table: 'hbr_claim', record: claim, operation: 1, at: commit, user: ctx.user, changes: b.values.get(`hbr_claim:${claim.id}`)! });
  b.flowRun({ flow: 'triage', triggeredAt: commit, save: { table: 'hbr_claim', recordId: claim.id } });
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
  const segmentChange = b.rng.chance(0.12);
  const changes: Raw = segmentChange
    ? { hbr_segment: b.rng.pick(['SMB', 'Mid', 'Enterprise'].filter((s) => s !== b.value('contact', contact.id, 'hbr_segment'))) }
    : b.rng.chance(0.5)
      ? { jobtitle: b.rng.pick(['Owner', 'CFO', 'Office manager', 'Buyer', 'Director']) }
      : { telephone1: `+1 555 1${b.rng.int(100, 999)}` };
  const items: PipelineItem[] = [simpleStep(ctx, b.step('contactAudit'), 1, 9, [`Audit snapshot for ${contact.name}`, 'Changed columns: (all columns: no filtering attributes)'])];
  let account: { id: string; name: string } | null = null;
  if (segmentChange) {
    account = b.record('account');
    const sync = b.step('contactSyncToAccount');
    items.push((at, requestId) => {
      const nested = pipeline(ctx, 2, at + b.rng.duration(20, 0.3), [simpleStep(ctx, b.step('accountContactCount'), 2, 30, [`Counting contacts of ${account!.name}`])]);
      const durationMs = nested.end - at + b.rng.duration(10, 0.3);
      b.traceLog({ step: sync, correlationId: ctx.correlationId, requestId, depth: 1, start: at, durationMs, user: ctx.user, lines: [enter(sync.typeName, ctx), `Copying segment to ${account!.name}`, exit(sync.typeName)] });
      return { end: at + durationMs };
    });
  }
  const r = pipeline(ctx, 1, t, items);
  const commit = r.end + b.rng.int(2, 15);
  const transactionId = b.audit({ table: 'contact', record: contact, operation: 2, at: commit, user: ctx.user, changes });
  if (account) b.audit({ table: 'account', record: account, operation: 2, at: commit, user: ctx.user, changes: { hbr_segment: changes['hbr_segment'] }, transactionId });
}

/**
 * A user renames an account or changes its phone number. AccountContactCount has no filtering
 * attributes so it runs; "Sync account to marketing" filters on exactly these columns, so it starts.
 */
function accountEdit(ctx: OpContext, t: number): void {
  const { b } = ctx;
  const account = b.record('account');
  const changes: Raw = b.rng.chance(0.4)
    ? { name: `${String(b.value('account', account.id, 'name')).replace(/ \(.*\)$/, '')} (${b.rng.pick(['HQ', 'Group', 'Ltd'])})` }
    : { telephone1: `+1 555 0${b.rng.int(100, 999)}` };
  const r = pipeline(ctx, 1, t, [simpleStep(ctx, b.step('accountContactCount'), 1, 28, [`Counting contacts of ${account.name}`])]);
  const commit = r.end + b.rng.int(2, 15);
  b.audit({ table: 'account', record: account, operation: 2, at: commit, user: ctx.user, changes });
  b.flowRun({ flow: 'marketing', triggeredAt: commit, save: { table: 'account', recordId: account.id } });
}

/**
 * Scenario 7: three status changes of one policy within two seconds (a bulk edit). Three
 * "Notify underwriter" runs start close together, so which run belongs to which save is
 * genuinely ambiguous; the record story shows lower confidence and says why.
 */
function statusBurst(b: Builder, t: number, daysAgo: number): void {
  const policy = { id: b.records['hbr_policy']!.ids[0]!, name: b.records['hbr_policy']!.names[0]! };
  b.values.set(`hbr_policy:${policy.id}`, { ...b.values.get(`hbr_policy:${policy.id}`), hbr_premium: 4200, hbr_status: 1 });
  const user = b.users[2]!;
  [2, 3, 1].forEach((status, i) => {
    const ctx: OpContext = { b, user, correlationId: b.rng.uuid(), daysAgo };
    policyUpdate(ctx, t + i * 650 + b.rng.int(0, 200), { policy, changes: { hbr_status: status }, flowDelayMs: b.rng.int(3000, 9000) });
  });
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

// ── definitions ──────────────────────────────────────────────────────────────

/** A solution-aware flow's clientdata, shaped like the real thing (only the parts the app reads). */
function flowClientdata(f: FlowDef): string {
  const trigger =
    f.message === 0
      ? { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object', properties: {} } } } }
      : {
          'When_a_row_is_added,_modified_or_deleted': {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: { connectionName: 'shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger', apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps' },
              parameters: {
                'subscriptionRequest/message': f.message,
                'subscriptionRequest/entityname': f.table,
                'subscriptionRequest/scope': 4,
                ...(f.filtering ? { 'subscriptionRequest/filteringattributes': f.filtering } : {}),
                ...(f.filter ? { 'subscriptionRequest/filterexpression': f.filter } : {}),
              },
              authentication: "@parameters('$authentication')",
            },
          },
        };
  return JSON.stringify({
    properties: {
      connectionReferences: {},
      definition: { $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#', contentVersion: '1.0.0.0', triggers: trigger, actions: {} },
    },
    schemaVersion: '1.0.0.0',
  });
}

function workflowRows(b: Builder, now: number): Raw[] {
  const modified = isoSeconds(now - 20 * DAY);
  const base = { scope: 4, triggerondelete: false, modifiedon: modified, _parentworkflowid_value: null, clientdata: null };
  const rows: Raw[] = [
    { ...base, workflowid: WORKFLOW_DEFINITION_ID, name: 'Calculate policy risk', category: 0, type: 1, statecode: 1, primaryentity: 'hbr_policy', mode: 0, triggeroncreate: true, triggeronupdateattributelist: null },
    { ...base, workflowid: WORKFLOW_ID, name: 'Calculate policy risk', category: 0, type: 2, statecode: 1, primaryentity: 'hbr_policy', mode: 0, triggeroncreate: true, triggeronupdateattributelist: null, _parentworkflowid_value: WORKFLOW_DEFINITION_ID },
    { ...base, workflowid: BUSINESS_RULE_ID, name: 'Premium must be positive', category: 2, type: 1, statecode: 1, primaryentity: 'hbr_policy', mode: null, triggeroncreate: false, triggeronupdateattributelist: null },
  ];
  for (const f of b.flows.values()) {
    rows.push({ ...base, workflowid: f.id, name: f.name, category: 5, type: 1, statecode: f.active ? 1 : 0, primaryentity: f.message === 0 ? 'none' : f.table, mode: 0, triggeroncreate: false, triggeronupdateattributelist: null, clientdata: flowClientdata(f) });
  }
  for (const r of rows) {
    r[`category${FV}`] = { 0: 'Workflow', 2: 'Business Rule', 5: 'Modern Flow' }[r['category'] as 0 | 2 | 5];
    r[`statecode${FV}`] = r['statecode'] === 1 ? 'Activated' : 'Draft';
  }
  return rows;
}

function recordRows(b: Builder): DemoDataset['records'] {
  const out: DemoDataset['records'] = {};
  for (const [key, values] of b.values) {
    const [table, id] = key.split(':') as [string, string];
    (out[table] ??= {})[id] = { [ENTITIES[table]!.PrimaryIdAttribute]: id, ...values };
  }
  return out;
}

// ── volume ───────────────────────────────────────────────────────────────────

/** Relative activity per local hour of a weekday (office hours, lunch dip). */
const HOURLY = [0.05, 0.03, 0.03, 0.03, 0.05, 0.1, 0.25, 0.6, 1.0, 1.1, 1.05, 0.95, 0.6, 0.85, 1.0, 1.0, 0.9, 0.7, 0.4, 0.25, 0.18, 0.12, 0.08, 0.06];

export function generateDemo(options: DemoOptions = {}): DemoDataset {
  const seed = options.seed ?? 20260924;
  const rng = new Rng(seed);
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
    // In time order, so each save sees the values of the saves before it.
    const times = Array.from({ length: count }, () => hourStart + Math.floor(rng.next() * HOUR)).sort((x, y) => x - y);
    for (const t of times) {
      const ctx: OpContext = { b, user: rng.pick(b.users), correlationId: rng.uuid(), daysAgo };
      const roll = rng.next();
      // The noisy ContactAudit step shows up more in the last 24 hours.
      const contactShare = daysAgo === 0 ? 0.55 : 0.4;
      if (roll < contactShare) contactUpdate(ctx, t);
      else if (roll < contactShare + 0.33) policyUpdate(ctx, t);
      else if (roll < contactShare + 0.45) policyCreate(ctx, t);
      else if (roll < contactShare + 0.52) accountEdit(ctx, t);
      else claimCreate(ctx, t);
    }
  }
  // Two loop incidents: one 3 days ago, one this morning.
  for (const ago of [3 * DAY + 2 * HOUR, 5 * HOUR]) {
    const t = now - ago;
    if (t > now - days * DAY) updateLoop({ b, user: b.users[1]!, correlationId: rng.uuid(), daysAgo: Math.floor(ago / DAY) }, t);
  }
  statusBurst(b, now - 2 * HOUR - 17 * 60_000, 0);

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
    seed,
    userId: b.users[0]!.id,
    organizationId: '0f5c2a1e-7b3d-4c9e-8a21-6d4f0b9c3e71',
    traceLogs: b.traceLogs.sort(byCreated('createdon')),
    asyncOperations: b.jobs.sort(byCreated('modifiedon')),
    steps,
    organization: {
      organizationid: '0f5c2a1e-7b3d-4c9e-8a21-6d4f0b9c3e71',
      plugintracelogsetting: 2,
      [`plugintracelogsetting${FV}`]: 'All',
      isauditenabled: true,
      maxuploadfilesize: 5_242_880,
    },
    userRoles: [{ roleid: '8a0d9c21-4b6e-4f7a-9d3c-2e1f5a7b9c04', _roletemplateid_value: SYSTEM_ADMINISTRATOR_ROLE_TEMPLATE }],
    audits: b.audits.sort(byCreated('createdon')),
    auditDetails: b.auditDetails,
    flowRuns: b.flowRuns.sort(byCreated('modifiedon')),
    flowEvents: [
      {
        floweventid: 'b4d1e7a2-6c3f-4a9e-8b05-2f7c1d9e3a64',
        eventtype: 'FlowRunIngestion',
        eventcode: 'FlowRunIngestionDelayed',
        level: 'Warning',
        name: 'Some flow runs between 03:10 and 03:40 UTC may be missing from run history.',
        createdon: isoSeconds(now - 2 * DAY - 5 * HOUR),
        _parentobjectid_value: null,
      },
    ].filter((e) => now - 2 * DAY - 5 * HOUR > now - days * DAY),
    workflows: workflowRows(b, now),
    callbackRegistrations: [...b.flows.values()]
      .filter((f) => f.active && f.message !== 0)
      .map((f) => ({
        callbackregistrationid: rng.uuid(),
        name: f.id,
        entityname: f.table,
        message: f.message,
        filteringattributes: f.filtering,
        filterexpression: f.filter,
        scope: 4,
      })),
    records: recordRows(b),
    entities: ENTITIES,
    truth: b.truth,
  };
}

// ── simulated saves (watch mode in the demo) ─────────────────────────────────

export type SimulatedTable = 'plugintracelogs' | 'asyncoperations' | 'audits' | 'flowruns';

export interface SimulatedSave {
  record: { table: string; id: string; name: string };
  /** Rows to reveal over time: each becomes visible to the API at `at`. */
  rows: Array<{ at: number; table: SimulatedTable; row: Raw }>;
  auditDetails: Record<string, Raw>;
}

/**
 * A status change of a policy made "now", as watch mode would see it: plugin rows first, then the
 * async job, then the flow run (whose history is written a few seconds after it ends).
 * Uses the dataset's seed, so step, flow and user ids match the rest of the demo.
 */
export function simulateSave(data: DemoDataset, options: { now: number; recordId?: string }): SimulatedSave {
  const b = new Builder(new Rng(data.seed), options.now + 10 * 60_000);
  b.rng.reseed(options.now % 2_147_483_647);
  b.flowWriteDelayMs = 4000;
  for (const [table, rows] of Object.entries(data.records)) {
    for (const [id, row] of Object.entries(rows)) b.values.set(`${table}:${id}`, { ...row });
  }
  const policies = data.records['hbr_policy']!;
  const id = options.recordId && policies[options.recordId] ? options.recordId : Object.keys(policies)[0]!;
  const policy = { id, name: String(policies[id]!['hbr_name']) };
  const current = Number(b.value('hbr_policy', id, 'hbr_status') ?? 1);
  const next = current >= 3 ? 1 : current + 1;
  const ctx: OpContext = { b, user: b.users[0]!, correlationId: b.rng.uuid(), daysAgo: 0 };
  // Keep the premium over the Notify flow's filter (hbr_premium gt 1000), so the demo always shows a flow.
  const premium = Number(b.value('hbr_policy', id, 'hbr_premium') ?? 0);
  const changes: Raw = premium > 1000 ? { hbr_status: next } : { hbr_status: next, hbr_premium: 1500 };
  policyUpdate(ctx, options.now + 1500, { policy, changes, flowDelayMs: 2500 });
  data.records['hbr_policy']![id] = { ...policies[id], ...b.values.get(`hbr_policy:${id}`) };
  const time = (row: Raw, column: string) => Date.parse(String(row[column]));
  const rows: SimulatedSave['rows'] = [
    ...b.traceLogs.map((row) => ({ at: time(row, 'createdon'), table: 'plugintracelogs' as const, row })),
    ...b.jobs.map((row) => ({ at: time(row, 'modifiedon'), table: 'asyncoperations' as const, row })),
    ...b.audits.map((row) => ({ at: time(row, 'createdon'), table: 'audits' as const, row })),
    ...b.flowRuns.map((row) => ({ at: time(row, 'createdon'), table: 'flowruns' as const, row })),
  ];
  return { record: { table: 'hbr_policy', ...policy }, rows: rows.sort((x, y) => x.at - y.at), auditDetails: b.auditDetails };
}
