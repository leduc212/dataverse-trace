// Correlation engine: assembles one Trace from the rows that share a correlation ID.
// Exact / structural rules only (R1–R5, R9 in docs/plan/architecture.md §7). Pure and deterministic:
// the output doesn't depend on the order of the input rows.
import { summarizeException } from './exception.ts';
import type { Caveat, Span, SpanLink, SpanStatus, Trace, TraceSummary } from './model.ts';
import type { AsyncOperationRecord, StepRegistration, TimePrecision, TraceLogRecord } from './records.ts';

export interface CorrelationInput {
  traceLogs: readonly TraceLogRecord[];
  asyncOps: readonly AsyncOperationRecord[];
  steps: ReadonlyMap<string, StepRegistration>;
  /** Used for spans that are still running. Defaults to the latest timestamp in the input. */
  now?: number;
}

/** Slack when comparing timestamps: whole-second timestamps can be up to 999 ms early. */
const tolerance = (p: TimePrecision) => (p === 's' ? 1000 : 5);

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

function jobStatus(statusCode: number): SpanStatus {
  if (statusCode === 30) return 'ok';
  if (statusCode === 31) return 'error';
  if (statusCode === 32) return 'canceled';
  if (statusCode === 0 || statusCode === 10) return 'waiting';
  return 'running';
}

function traceLogSpan(log: TraceLogRecord, traceKey: string, step: StepRegistration | undefined): Span {
  const errorText = summarizeException(log.exception);
  const span: Span = {
    id: `plugintracelog:${log.id}`,
    traceKey,
    kind: log.operationType === 'workflowActivity' ? 'workflowActivity' : 'plugin',
    name: log.typeName,
    source: { table: 'plugintracelog', id: log.id },
    lane: log.mode === 'sync' ? 'sync' : 'async',
    start: log.start,
    end: log.start + log.durationMs,
    precision: log.precision,
    status: log.exception ? 'error' : 'ok',
    depth: log.depth,
    mode: log.mode,
    message: log.messageName,
    metrics: { durationMs: log.durationMs },
    attrs: {},
  };
  if (log.constructorMs !== null) span.metrics.constructorMs = log.constructorMs;
  if (log.primaryEntity) span.table = log.primaryEntity;
  if (log.correlationId) span.correlationId = log.correlationId;
  if (log.requestId) span.requestId = log.requestId;
  if (log.stepId) span.stepId = log.stepId;
  if (step) {
    span.stage = step.stage;
    span.rank = step.rank;
    span.attrs['step.name'] = step.name;
    if (step.assemblyName) span.attrs['assembly'] = step.assemblyName;
  }
  if (errorText) span.error = { message: errorText };
  return span;
}

function jobSpan(job: AsyncOperationRecord, traceKey: string, now: number): Span {
  const status = jobStatus(job.statusCode);
  const start = job.startedOn ?? job.createdOn;
  const span: Span = {
    id: `asyncoperation:${job.id}`,
    traceKey,
    kind: 'systemJob',
    name: job.name || job.operationTypeLabel,
    source: { table: 'asyncoperation', id: job.id },
    lane: 'async',
    start,
    queuedAt: job.createdOn,
    precision: job.precision,
    status,
    mode: 'async',
    metrics: { retries: job.retryCount },
    attrs: { 'job.operationType': job.operationType, 'job.status': job.statusLabel },
  };
  if (job.completedOn !== null) {
    span.end = job.completedOn;
    span.metrics.durationMs = job.completedOn - start;
  } else if (status === 'running') {
    span.metrics.durationMs = now - start;
  }
  if (job.startedOn !== null) span.metrics.queueMs = job.startedOn - job.createdOn;
  if (job.depth !== null) span.depth = job.depth;
  if (job.messageName) span.message = job.messageName;
  if (job.primaryEntity) span.table = job.primaryEntity;
  if (job.correlationId) span.correlationId = job.correlationId;
  if (job.requestId) span.requestId = job.requestId;
  if (job.stepId) span.stepId = job.stepId;
  if (job.workflowId) span.attrs['workflowId'] = job.workflowId;
  if (job.regarding) span.record = { ...job.regarding, exact: true };
  if (status === 'error') span.error = { message: job.message ?? `Failed (error code ${job.errorCode ?? '?'})` };
  return span;
}

const endOf = (s: Span) => s.end ?? s.start + (s.metrics.durationMs ?? 0);

/** Orders spans inside one message pipeline: stage, then rank, then start, then id. */
function pipelineOrder(a: Span, b: Span): number {
  return cmp(a.stage ?? 99, b.stage ?? 99) || cmp(a.rank ?? 0, b.rank ?? 0) || cmp(a.start, b.start) || cmp(a.id, b.id);
}

export function assembleTrace(correlationId: string, input: CorrelationInput): Trace | null {
  const logs = input.traceLogs.filter((l) => l.correlationId === correlationId);
  const jobs = input.asyncOps.filter((j) => j.correlationId === correlationId);
  if (logs.length === 0 && jobs.length === 0) return null;

  const traceKey = correlationId;
  const now =
    input.now ??
    Math.max(...logs.map((l) => l.start + l.durationMs), ...jobs.map((j) => j.completedOn ?? j.startedOn ?? j.createdOn));
  const spans: Span[] = [];
  const links: SpanLink[] = [];
  const caveats: Caveat[] = [];
  const link = (from: string, to: string, rule: string, confidence: number, label: string, type: SpanLink['type'] = 'childOf') =>
    links.push({ from, to, type, confidence, rule, evidence: [{ label, weight: confidence }] });

  const logSpans = [...logs]
    .sort((a, b) => cmp(a.id, b.id))
    .map((l) => traceLogSpan(l, traceKey, l.stepId ? input.steps.get(l.stepId) : undefined));
  const jobSpans = [...jobs].sort((a, b) => cmp(a.id, b.id)).map((j) => jobSpan(j, traceKey, now));
  spans.push(...logSpans, ...jobSpans);

  // R2: sync trace rows with the same request id and depth form one message pipeline.
  const requests = new Map<string, Span[]>();
  for (const s of logSpans) {
    if (s.mode !== 'sync') continue;
    const key = `${s.requestId ?? `none:${s.id}`}|${s.depth ?? 0}`;
    const group = requests.get(key);
    if (group) group.push(s);
    else requests.set(key, [s]);
  }
  const requestSpans: Span[] = [];
  /** Total execution time of a request's steps: they run one after another, so the request takes at least this long. */
  const workMs = new Map<string, number>();  for (const [key, members] of [...requests.entries()].sort(([a], [b]) => cmp(a, b))) {
    members.sort(pipelineOrder);
    const first = members[0]!;
    const precision: TimePrecision = members.some((m) => m.precision === 's') ? 's' : 'ms';
    const request: Span = {
      id: `request:${traceKey}:${key}`,
      traceKey,
      kind: 'request',
      name: [first.message, first.table].filter(Boolean).join(' ') || 'Request',
      source: null,
      lane: 'sync',
      start: Math.min(...members.map((m) => m.start)),
      end: Math.max(...members.map(endOf)),
      precision,
      status: members.some((m) => m.status === 'error') ? 'error' : 'ok',
      depth: first.depth ?? 0,
      mode: 'sync',
      metrics: {},
      attrs: { steps: members.length },
    };
    request.metrics.durationMs = request.end! - request.start;
    if (first.message) request.message = first.message;
    if (first.table) request.table = first.table;
    if (first.requestId) request.requestId = first.requestId;
    request.correlationId = correlationId;
    requestSpans.push(request);
    workMs.set(request.id, members.reduce((sum, m) => sum + (m.metrics.durationMs ?? 0), 0));    for (const m of members) link(request.id, m.id, 'R2', 1, 'same correlation id + request id + depth');
  }
  spans.push(...requestSpans);

  // R3: a request at depth d+1 runs inside a plugin at depth d. The parent must be able to contain
  // it: its duration covers the request's work, and — given starts that may be truncated to the
  // second — there's a placement where the request starts after the parent and ends before it.
  // Among feasible parents, the one with the least slack wins.
  const plugins = logSpans.filter((s) => s.kind === 'plugin' || s.kind === 'workflowActivity');
  let ambiguous = false;
  for (const request of requestSpans) {
    const depth = request.depth ?? 0;
    const work = workMs.get(request.id) ?? 0;
    const slackOf = (p: Span) => (p.metrics.durationMs ?? 0) - work;
    const candidates = plugins
      .filter((p) => {
        if ((p.depth ?? 0) !== depth - 1) return false;
        const tol = Math.max(tolerance(p.precision), tolerance(request.precision));
        const slack = slackOf(p);
        // (createdon isn't used: when the platform writes trace rows isn't documented.)
        return slack >= 0 && request.start + tol >= p.start && request.start <= p.start + tol + slack;
      })
      .sort((a, b) => cmp(slackOf(a), slackOf(b)) || cmp(a.id, b.id));
    if (candidates.length === 0) continue;
    const parent = candidates[0]!;
    if (candidates.length === 1) {
      link(parent.id, request.id, 'R3', 1, `only depth-${depth - 1} step that can contain this request`);
    } else {
      ambiguous = true;
      link(parent.id, request.id, 'R3', 1 / candidates.length, `closest fit of ${candidates.length} depth-${depth - 1} steps that can contain this request`);
    }
  }

  // R4: async trace rows belong to the system job for the same step in this correlation. Custom
  // workflow activities have no step: they run inside a workflow job (operation type 10).
  let missingJob = false;
  const isWorkflowJob = (j: Span) => j.attrs['job.operationType'] === 10;
  for (const log of logSpans.filter((s) => s.mode === 'async')) {
    const tol = tolerance(log.precision);
    const candidates = jobSpans
      .filter((j) => (log.kind === 'workflowActivity' ? isWorkflowJob(j) : Boolean(j.stepId) && j.stepId === log.stepId))
      .map((j) => ({ j, inside: log.start >= j.start - tol && log.start <= (j.end ?? now) + tol }))
      .sort((a, b) => Number(b.inside) - Number(a.inside) || cmp(Math.abs(a.j.start - log.start), Math.abs(b.j.start - log.start)) || cmp(a.j.id, b.j.id));
    const best = candidates[0];
    if (!best) {
      missingJob = true;
      continue;
    }
    const insideCount = candidates.filter((c) => c.inside).length;
    const confidence = best.inside && insideCount === 1 ? 1 : 1 / Math.max(candidates.length, 1);
    const why =
      log.kind === 'workflowActivity'
        ? 'workflow job in this correlation whose run window contains the activity'
        : 'system job for the same step (owningextensionid) in this correlation';
    link(best.j.id, log.id, 'R4', confidence, why);
  }

  // R4b: a system job follows from the request that queued it (same request id).
  for (const job of jobSpans) {
    if (!job.requestId) continue;
    const queuing = requestSpans
      .filter((r) => r.requestId === job.requestId)
      .sort((a, b) => cmp(a.depth ?? 0, b.depth ?? 0) || cmp(a.id, b.id))[0];
    if (queuing) link(queuing.id, job.id, 'R4', 1, 'queued by the request with the same request id', 'followsFrom');
  }

  if (logSpans.some((s) => s.precision === 's') || jobSpans.some((s) => s.precision === 's')) {
    caveats.push({
      code: 'secondPrecision',
      message: 'Start times come back in whole seconds, so positions within a second are estimated. Durations are exact.',
    });
  }
  if (ambiguous) {
    caveats.push({ code: 'ambiguousNesting', message: 'Some nested requests could belong to more than one parent step; the tightest fit is shown.' });
  }
  if (missingJob) {
    caveats.push({
      code: 'asyncJobMissing',
      message: 'Some async steps have no system job (jobs of steps with "delete when successful" are removed).',
    });
  }

  // R5: record anchor from the lowest-depth system job's regarding record.
  const rootRequest = [...requestSpans].sort((a, b) => cmp(a.depth ?? 0, b.depth ?? 0) || cmp(a.start, b.start) || cmp(a.id, b.id))[0];
  const anchorJob = [...jobs]
    .filter((j) => j.regarding)
    .sort(
      (a, b) =>
        Number(b.regarding!.table === rootRequest?.table) - Number(a.regarding!.table === rootRequest?.table) ||
        cmp(a.depth ?? 99, b.depth ?? 99) ||
        cmp(a.id, b.id),
    )[0];

  const trace: Trace = { key: traceKey, spans, links, caveats, summary: summarize(spans, rootRequest) };
  if (anchorJob?.regarding) trace.anchor = { ...anchorJob.regarding, exact: true };
  return trace;
}

function summarize(spans: Span[], rootRequest: Span | undefined): TraceSummary {
  const starts = spans.map((s) => s.queuedAt ?? s.start);
  const ends = spans.map(endOf);
  const start = Math.min(...starts);
  const end = Math.max(...ends);
  const counts: TraceSummary['counts'] = {};
  for (const s of spans) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const minDepth = Math.min(...spans.filter((s) => s.kind === 'request').map((s) => s.depth ?? 0));
  const syncMs = spans
    .filter((s) => s.kind === 'request' && (s.depth ?? 0) === minDepth)
    .reduce((sum, s) => sum + (s.metrics.durationMs ?? 0), 0);
  const fallbackTitle = spans.find((s) => s.kind === 'systemJob')?.name ?? spans[0]?.name ?? 'Trace';
  return {
    start,
    end,
    wallMs: end - start,
    syncMs,
    errors: spans.filter((s) => s.status === 'error' && s.kind !== 'request').length,
    maxDepth: Math.max(0, ...spans.map((s) => s.depth ?? 0)),
    counts,
    title: rootRequest?.name ?? fallbackTitle,
  };
}

/** Lightweight per-correlation summary for list views (no span building). */
export interface OperationSummary {
  correlationId: string;
  start: number;
  end: number;
  steps: number;
  errors: number;
  maxDepth: number;
  title: string;
  tables: string[];
}

export function summarizeOperations(logs: readonly TraceLogRecord[]): OperationSummary[] {
  const groups = new Map<string, TraceLogRecord[]>();
  for (const l of logs) {
    if (!l.correlationId) continue;
    const g = groups.get(l.correlationId);
    if (g) g.push(l);
    else groups.set(l.correlationId, [l]);
  }
  const result: OperationSummary[] = [];
  for (const [correlationId, rows] of groups) {
    const root = rows.reduce((a, b) => (b.depth < a.depth || (b.depth === a.depth && b.start < a.start) ? b : a));
    result.push({
      correlationId,
      start: Math.min(...rows.map((r) => r.start)),
      end: Math.max(...rows.map((r) => r.start + r.durationMs)),
      steps: rows.length,
      errors: rows.filter((r) => r.exception).length,
      maxDepth: Math.max(...rows.map((r) => r.depth)),
      title: [root.messageName, root.primaryEntity].filter(Boolean).join(' '),
      tables: [...new Set(rows.map((r) => r.primaryEntity).filter((t): t is string => Boolean(t)))].sort(),
    });
  }
  return result.sort((a, b) => b.start - a.start || cmp(a.correlationId, b.correlationId));
}
