// The record story: what ran when one record was saved.
//
// A save comes from audit (who, when, which columns) or, when audit is off, from a system job whose
// regarding record is this one. The rest is linked to the save:
//   R5  exact    the operation (correlation) has a system job regarding this record
//   I1  inferred the operation's sync pipeline, on the same table and message, contains the save time
//   I2  inferred a cloud flow whose trigger matches ran shortly after the save
//   R6  exact    child flow runs (parentRunId)
// Every inferred link carries its evidence, and nothing inferred is ever drawn as exact.
import { assembleTrace, summarize } from './correlate.ts';
import { changeKindOf, matchFilteringAttributes } from './flows.ts';
import type { Caveat, Evidence, Span, SpanLink, Trace } from './model.ts';
import { evaluateKnown } from './odata.ts';
import type {
  AsyncOperationRecord,
  AuditRecord,
  ChangeKind,
  EpochMs,
  FlowRunRecord,
  ProcessDefinition,
  RecordRef,
  StepRegistration,
  TimePrecision,
  TraceLogRecord,
} from './records.ts';

export interface SaveEvent {
  id: string;
  record: RecordRef;
  /** Audit time (the commit), or the start of the operation when found through a system job. */
  time: EpochMs;
  change: ChangeKind | 'other';
  userId: string | null;
  userName: string | null;
  /** `null` = not known (no audit details). */
  changedColumns: string[] | null;
  newValues: Record<string, unknown> | null;
  source: 'audit' | 'systemJob';
  auditIds: string[];
  /** Operation found directly (system jobs), when known. */
  correlationId: string | null;
  precision: TimePrecision;
}

export interface RecordStoryInput {
  record: RecordRef;
  audits: readonly AuditRecord[];
  /** Candidate rows around the save (the caller narrows by time). */
  traceLogs: readonly TraceLogRecord[];
  asyncOps: readonly AsyncOperationRecord[];
  flowRuns: readonly FlowRunRecord[];
  processes: readonly ProcessDefinition[];
  steps: ReadonlyMap<string, StepRegistration>;
  /** Current column values of the record, for flow filter expressions. May be partial. */
  recordValues?: Record<string, unknown>;
  /** Every save of the record (from findSaves): nearby saves compete for the same flow runs. */
  saves?: readonly SaveEvent[];
  /** How long after a save a triggered flow run may start. Default 5 minutes. */
  flowWindowMs?: number;
  now?: number;
}

/** How a flow relates to a save: fired (with the run and confidence), or why it didn't. */
export interface FlowOutcome {
  processId: string;
  processName: string;
  shouldRun: true | false | 'unknown';
  reasons: string[];
  runId: string | null;
  spanId: string | null;
  confidence: number | null;
}

export interface RecordStory {
  save: SaveEvent;
  trace: Trace;
  correlationId: string | null;
  correlationConfidence: number | null;
  flows: FlowOutcome[];
}

const TOLERANCE_MS = 1000;
const SAVE_MERGE_MS = 5000;
const FLOW_EARLY_MS = 2000;
const FLOW_HALF_LIFE_MS = 20_000;
/** Inferred links never reach 1, so they're never drawn as exact, however strong the evidence. */
export const MAX_INFERRED_CONFIDENCE = 0.95;
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
const sameId = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

interface OperationRoot {
  correlationId: string;
  table: string | null;
  change: ChangeKind | null;
  start: number;
  end: number;
  createdById: string | null;
  precision: TimePrecision;
}

/** The depth-1 (lowest-depth) sync pipeline of each operation. */
export function operationRoots(logs: readonly TraceLogRecord[]): Map<string, OperationRoot> {
  const byCorrelation = new Map<string, TraceLogRecord[]>();
  for (const l of logs) {
    if (!l.correlationId || l.mode !== 'sync') continue;
    const list = byCorrelation.get(l.correlationId);
    if (list) list.push(l);
    else byCorrelation.set(l.correlationId, [l]);
  }
  const roots = new Map<string, OperationRoot>();
  for (const [correlationId, rows] of byCorrelation) {
    const minDepth = Math.min(...rows.map((r) => r.depth));
    const top = rows.filter((r) => r.depth === minDepth);
    const first = top.reduce((a, b) => (b.start < a.start ? b : a));
    roots.set(correlationId, {
      correlationId,
      table: first.primaryEntity,
      change: changeKindOf(first.messageName),
      start: Math.min(...top.map((r) => r.start)),
      // Steps of one pipeline run one after another, so the pipeline lasts at least their total.
      end: Math.min(...top.map((r) => r.start)) + top.reduce((sum, r) => sum + r.durationMs, 0),
      createdById: first.createdById,
      precision: first.precision,
    });
  }
  return roots;
}

/** Saves of a record, newest first: from audit, plus operations found through system jobs. */
export function findSaves(input: Pick<RecordStoryInput, 'record' | 'audits' | 'traceLogs' | 'asyncOps'>): SaveEvent[] {
  const { record } = input;
  const saves: SaveEvent[] = [];
  const audits = input.audits
    .filter((a) => a.table === record.table && sameId(a.recordId, record.id) && a.operation !== 'other')
    .sort((a, b) => a.createdOn - b.createdOn || cmp(a.id, b.id));
  // One save per transaction (or per user and second when there's no transaction id).
  const groups = new Map<string, AuditRecord[]>();
  for (const a of audits) {
    const key = a.transactionId ?? `${a.userId}|${Math.floor(a.createdOn / 1000)}|${a.operation}`;
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const known = group.every((a) => a.changedColumns !== null);
    saves.push({
      id: `audit:${first.id}`,
      record,
      time: first.createdOn,
      change: first.operation,
      userId: first.userId,
      userName: first.userName,
      changedColumns: known ? [...new Set(group.flatMap((a) => a.changedColumns!))].sort() : null,
      newValues: known ? Object.assign({}, ...group.map((a) => a.newValues ?? {})) : null,
      source: 'audit',
      auditIds: group.map((a) => a.id),
      correlationId: null,
      precision: first.precision,
    });
  }

  // Operations with a system job regarding this record that no audited save explains.
  const roots = operationRoots(input.traceLogs);
  const jobsByCorrelation = new Map<string, AsyncOperationRecord[]>();
  for (const j of input.asyncOps) {
    if (!j.correlationId || !j.regarding || j.regarding.table !== record.table || !sameId(j.regarding.id, record.id)) continue;
    const list = jobsByCorrelation.get(j.correlationId);
    if (list) list.push(j);
    else jobsByCorrelation.set(j.correlationId, [j]);
  }
  for (const [correlationId, jobs] of [...jobsByCorrelation.entries()].sort(([a], [b]) => cmp(a, b))) {
    const root = roots.get(correlationId);
    const time = root?.start ?? Math.min(...jobs.map((j) => j.createdOn));
    if (saves.some((s) => s.source === 'audit' && Math.abs(s.time - time) <= SAVE_MERGE_MS)) continue;
    const job = jobs[0]!;
    saves.push({
      id: `job:${correlationId}`,
      record: job.regarding!,
      time,
      change: changeKindOf(root?.change ?? job.messageName) ?? 'other',
      userId: root?.createdById ?? null,
      userName: null,
      changedColumns: null,
      newValues: null,
      source: 'systemJob',
      auditIds: [],
      correlationId,
      precision: root?.precision ?? job.precision,
    });
  }
  return saves.sort((a, b) => b.time - a.time || cmp(a.id, b.id));
}

interface Candidate {
  correlationId: string;
  score: number;
  exact: boolean;
  evidence: Evidence[];
}

/** Which operation (correlation) is this save? Exact through a system job (R5), otherwise I1. */
function matchOperation(save: SaveEvent, input: RecordStoryInput, roots: Map<string, OperationRoot>): Candidate | null {
  const { record } = input;
  if (save.correlationId) {
    return { correlationId: save.correlationId, score: 1, exact: true, evidence: [{ label: 'found through a system job regarding this record', weight: 1 }] };
  }
  // R5: a system job in the operation is regarding this record, and the operation is at the save time.
  const exact: Candidate[] = [];
  for (const j of input.asyncOps) {
    if (!j.correlationId || !j.regarding || !sameId(j.regarding.id, record.id)) continue;
    const root = roots.get(j.correlationId);
    const t0 = root?.start ?? j.createdOn;
    const t1 = root?.end ?? j.createdOn;
    if (save.time >= t0 - SAVE_MERGE_MS && save.time <= t1 + SAVE_MERGE_MS && !exact.some((c) => c.correlationId === j.correlationId)) {
      exact.push({ correlationId: j.correlationId, score: 1, exact: true, evidence: [{ label: `system job "${j.name}" in this operation is regarding this record`, weight: 1 }] });
    }
  }
  if (exact.length === 1) return exact[0]!;

  // I1: the operation's top-level pipeline is on this table and message, and contains the save time.
  const candidates: Candidate[] = [];
  for (const root of roots.values()) {
    if (root.table !== record.table || root.change !== save.change) continue;
    if (save.time < root.start - TOLERANCE_MS || save.time > root.end + TOLERANCE_MS) continue;
    const evidence: Evidence[] = [
      { label: 'the save time falls inside this operation\'s sync pipeline', weight: 0.45 },
      { label: `same table and message (${save.change} ${record.table})`, weight: 0.15 },
    ];
    if (save.userId && root.createdById) {
      evidence.push(
        sameId(save.userId, root.createdById)
          ? { label: 'trace rows were created by the user who saved (createdby; meaning not yet verified, spike S2)', weight: 0.2 }
          : { label: 'trace rows were created by a different user', weight: -0.2 },
      );
    }
    const score = evidence.reduce((s, e) => s + e.weight, 0);
    candidates.push({ correlationId: root.correlationId, score, exact: false, evidence });
  }
  if (candidates.length === 0) return exact[0] ?? null;
  candidates.sort((a, b) => b.score - a.score || cmp(a.correlationId, b.correlationId));
  const best = candidates[0]!;
  if (candidates.length === 1) {
    best.evidence.push({ label: 'the only operation on this table at that time', weight: 0.2 });
    best.score += 0.2;
  } else {
    const second = candidates[1]!;
    const factor = Math.min(1, Math.max(0.3, (best.score - second.score) / best.score));
    best.evidence.push({ label: `${candidates.length} operations on ${record.table} ran at that time`, weight: 0 });
    best.score *= factor;
  }
  best.score = Math.max(0.01, Math.min(MAX_INFERRED_CONFIDENCE, best.score));
  return best;
}

function flowStatus(run: FlowRunRecord): Span['status'] {
  return run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'error' : run.status === 'cancelled' ? 'canceled' : run.status === 'running' ? 'running' : 'ok';
}

function flowSpan(run: FlowRunRecord, traceKey: string, name: string): Span {
  const span: Span = {
    id: `flowrun:${run.id}`,
    traceKey,
    kind: 'flowRun',
    name,
    source: { table: 'flowrun', id: run.id },
    lane: 'flow',
    start: run.start,
    precision: run.precision,
    status: flowStatus(run),
    mode: 'async',
    metrics: {},
    attrs: { 'flow.status': run.statusLabel, 'flow.run': run.runId },
  };
  if (run.end !== null) {
    span.end = run.end;
    span.metrics.durationMs = run.durationMs ?? run.end - run.start;
  }
  if (run.triggerType) span.attrs['flow.trigger'] = run.triggerType;
  if (run.errorMessage || run.status === 'failed') span.error = { message: run.errorMessage ?? `Failed${run.errorCode ? ` (${run.errorCode})` : ''}` };
  if (run.errorCode) span.error ??= { message: run.errorCode };
  return span;
}

interface FlowCandidate {
  run: FlowRunRecord;
  delay: number;
  proximity: number;
  /** Trigger evidence plus time proximity, before the ambiguity factors. */
  score: number;
}

/**
 * Could this flow have been triggered by this save, and which of its runs fit? `null` when the
 * flow doesn't listen to this table and change. Candidates are sorted by delay.
 */
function evaluateFlow(save: SaveEvent, p: ProcessDefinition, input: RecordStoryInput, windowMs: number): { outcome: FlowOutcome; evidence: Evidence[]; candidates: FlowCandidate[] } | null {
  const trigger = p.flowTrigger!;
  if (trigger.table !== input.record.table || save.change === 'other' || !trigger.changes.includes(save.change)) return null;
  const outcome: FlowOutcome = { processId: p.id, processName: p.name, shouldRun: true, reasons: [], runId: null, spanId: null, confidence: null };
  if (!p.active) return { outcome: { ...outcome, shouldRun: false, reasons: ['the flow is turned off'] }, evidence: [], candidates: [] };
  const columns = matchFilteringAttributes(save.change, trigger.filteringAttributes, save.changedColumns);
  outcome.reasons.push(columns.reason);
  if (columns.match === false) return { outcome: { ...outcome, shouldRun: false }, evidence: [], candidates: [] };
  const evidence: Evidence[] = [
    { label: `trigger: ${trigger.changes.join('/')} of ${trigger.table}`, weight: 0.15 },
    { label: columns.reason, weight: trigger.filteringAttributes === null ? 0.1 : columns.match === true ? 0.25 : 0.05 },
  ];
  if (trigger.filterExpression) {
    const snapshot = { ...(input.recordValues ?? {}), ...(save.newValues ?? {}) };
    const filter = evaluateKnown(trigger.filterExpression, snapshot);
    if (filter.result === false) {
      return { outcome: { ...outcome, shouldRun: false, reasons: [...outcome.reasons, `filter "${trigger.filterExpression}" is false for this record`] }, evidence: [], candidates: [] };
    }
    const why =
      filter.result === true
        ? `filter "${trigger.filterExpression}" is true for this record`
        : `filter "${trigger.filterExpression}" couldn't be checked${filter.missing.length ? ` (${filter.missing.join(', ')} not known)` : ''}`;
    outcome.reasons.push(why);
    evidence.push({ label: why, weight: filter.result === true ? 0.2 : 0 });
    if (filter.result === 'unknown') outcome.shouldRun = 'unknown';
  } else {
    evidence.push({ label: 'no filter expression', weight: 0.2 });
  }
  if (trigger.conditions.length) {
    outcome.reasons.push(`has ${trigger.conditions.length} trigger condition(s) that can't be checked`);
    outcome.shouldRun = 'unknown';
  }
  if (p.subscription === 'missing') {
    outcome.reasons.push('no live trigger subscription matches this trigger (the flow may be broken or its connection expired)');
    outcome.shouldRun = 'unknown';
    evidence.push({ label: 'no live trigger subscription was found', weight: 0 });
  } else if (p.subscription === 'found') {
    evidence.push({ label: 'a live trigger subscription matches this trigger', weight: 0 });
  }
  const base = evidence.reduce((s, e) => s + e.weight, 0);
  const candidates = input.flowRuns
    .filter((r) => sameId(r.workflowId, p.id) && r.start >= save.time - FLOW_EARLY_MS && r.start <= save.time + windowMs)
    .map((run) => {
      const delay = Math.max(0, run.start - save.time);
      const proximity = Math.exp(-delay / FLOW_HALF_LIFE_MS);
      return { run, delay, proximity, score: base + 0.3 * proximity };
    })
    .sort((a, b) => a.delay - b.delay || cmp(a.run.id, b.run.id));
  return { outcome, evidence, candidates };
}

export function buildRecordStory(save: SaveEvent, input: RecordStoryInput): RecordStory {
  const { record } = input;
  const windowMs = input.flowWindowMs ?? 5 * 60_000;
  const roots = operationRoots(input.traceLogs);
  const traceKey = `record:${record.table}:${record.id}:${save.time}`;
  const spans: Span[] = [];
  const links: SpanLink[] = [];
  const caveats: Caveat[] = [];

  // The save itself: an instant on the audit lane.
  const saveSpan: Span = {
    id: `save:${save.id}`,
    traceKey,
    kind: 'audit',
    name: `${save.change === 'other' ? 'Change' : save.change[0]!.toUpperCase() + save.change.slice(1)} ${record.name ?? record.table}${save.userName ? ` by ${save.userName}` : ''}`,
    source: save.auditIds[0] ? { table: 'audit', id: save.auditIds[0] } : null,
    lane: 'audit',
    start: save.time,
    end: save.time,
    precision: save.precision,
    status: 'ok',
    record: { ...record, exact: true },
    metrics: { durationMs: 0 },
    attrs: save.changedColumns ? { 'save.columns': save.changedColumns.join(', ') } : {},
  };
  spans.push(saveSpan);

  // The operation (sync pipeline, async jobs and plugins) behind the save.
  const op = matchOperation(save, input, roots);
  if (op) {
    const t = assembleTrace(op.correlationId, { traceLogs: input.traceLogs, asyncOps: input.asyncOps, steps: input.steps, ...(input.now !== undefined ? { now: input.now } : {}) });
    if (t) {
      spans.push(...t.spans);
      links.push(...t.links);
      caveats.push(...t.caveats);
      const minDepth = Math.min(...t.spans.filter((s) => s.kind === 'request').map((s) => s.depth ?? 0));
      const tops = t.spans.filter((s) => s.kind === 'request' && (s.depth ?? 0) === minDepth);
      const targets = tops.length ? tops : t.spans.filter((s) => !t.links.some((l) => l.to === s.id));
      for (const target of targets) {
        links.push({ from: saveSpan.id, to: target.id, type: 'triggeredBy', confidence: op.score, rule: op.exact ? 'R5' : 'I1', evidence: op.evidence });
      }
    }
  } else if (save.change !== 'other') {
    caveats.push({ code: 'noOperationFound', message: 'No plug-in executions were found for this save (no custom plugins ran, tracing was off, or the logs were deleted before they were synced).' });
  }

  // Flows (I2) and why others didn't fire. Nearby saves of this record compete for the same runs:
  // saves and runs are paired one-to-one, best score first, so one run can't explain two saves.
  const flows: FlowOutcome[] = [];
  const competitorRoots = [...roots.values()].filter((r) => r.correlationId !== op?.correlationId && r.table === record.table && r.change === save.change);
  const peers = (input.saves ?? []).filter((s) => s.id !== save.id && Math.abs(s.time - save.time) <= windowMs);
  for (const p of [...input.processes].filter((x) => x.category === 'flow' && x.flowTrigger).sort((a, b) => cmp(a.name, b.name))) {
    const own = evaluateFlow(save, p, input, windowMs);
    if (!own) continue;
    const { outcome, evidence } = own;
    if (outcome.shouldRun === false) {
      flows.push(outcome);
      continue;
    }
    const pairs: Array<{ saveId: string; c: FlowCandidate }> = own.candidates.map((c) => ({ saveId: save.id, c }));
    for (const peer of peers) {
      const e = evaluateFlow(peer, p, input, windowMs);
      if (e && e.outcome.shouldRun !== false) for (const c of e.candidates) pairs.push({ saveId: peer.id, c });
    }
    pairs.sort((a, b) => b.c.score - a.c.score || a.c.delay - b.c.delay || cmp(a.saveId, b.saveId) || cmp(a.c.run.id, b.c.run.id));
    const runOwner = new Map<string, string>();
    const matched = new Set<string>();
    for (const pair of pairs) {
      if (matched.has(pair.saveId) || runOwner.has(pair.c.run.id)) continue;
      matched.add(pair.saveId);
      runOwner.set(pair.c.run.id, pair.saveId);
    }
    const best = own.candidates.find((c) => runOwner.get(c.run.id) === save.id);
    if (!best) {
      outcome.reasons.push(
        own.candidates.length
          ? 'the runs after this save were matched to other saves of this record that fit them better'
          : 'no run of this flow was found after the save (flow run history can be late or incomplete)',
      );
      flows.push(outcome);
      continue;
    }
    evidence.push({ label: `started ${Math.round(best.delay / 1000)} s after the save`, weight: 0.3 * best.proximity });
    let confidence = best.score;
    // Other saves of the same table just before the run could have triggered it instead.
    const others = competitorRoots
      .map((r) => r.end)
      .filter((end) => end >= best.run.start - windowMs && end <= best.run.start + FLOW_EARLY_MS)
      .map((end) => Math.exp(-Math.max(0, best.run.start - end) / FLOW_HALF_LIFE_MS));
    if (others.length) {
      const share = best.proximity / (best.proximity + others.reduce((a, b) => a + b, 0));
      evidence.push({ label: `${others.length} other ${record.table} save(s) happened shortly before this run; this save's share is ${Math.round(share * 100)} %`, weight: 0 });
      confidence *= share;
    }
    // Runs this save could still claim (not matched to another of its saves).
    const open = own.candidates.filter((c) => c !== best && !runOwner.has(c.run.id));
    if (open.length) {
      const second = open[0]!;
      const factor = Math.min(1, Math.max(0.3, (best.proximity - second.proximity) / best.proximity));
      if (factor < 1) {
        evidence.push({ label: `${open.length + 1} runs of this flow started in the window`, weight: 0 });
        confidence *= factor;
      }
    }
    if (peers.length && pairs.some((x) => x.saveId !== save.id)) {
      evidence.push({ label: `${peers.length} other save(s) of this record in the window; runs were paired one-to-one`, weight: 0 });
    }
    confidence = Math.max(0.01, Math.min(MAX_INFERRED_CONFIDENCE, confidence));
    const span = flowSpan(best.run, traceKey, best.run.flowName ?? p.name);
    span.queuedAt = save.time;
    spans.push(span);
    links.push({ from: saveSpan.id, to: span.id, type: 'triggeredBy', confidence, rule: 'I2', evidence });
    flows.push({ ...outcome, runId: best.run.id, spanId: span.id, confidence });

    // R6: child flows called by this run.
    const queue = [best.run];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const child of input.flowRuns.filter((r) => sameId(r.parentRunId, parent.runId)).sort((a, b) => a.start - b.start)) {
        const childSpan = flowSpan(child, traceKey, child.flowName ?? 'Child flow');
        spans.push(childSpan);
        links.push({ from: `flowrun:${parent.id}`, to: childSpan.id, type: 'childOf', confidence: 1, rule: 'R6', evidence: [{ label: 'parent run id', weight: 1 }] });
        queue.push(child);
      }
    }
  }

  if (flows.some((f) => f.runId)) {
    caveats.push({ code: 'inferredFlows', message: 'Flow runs are linked by timing and trigger settings (flow run history has no record id). Each link shows its confidence.' });
  }
  if (save.changedColumns === null && save.change === 'update') {
    caveats.push({ code: 'columnsUnknown', message: 'The changed columns of this save aren\'t known (no audit details), so filtering attributes couldn\'t be checked.' });
  }
  const uniqueCaveats = caveats.filter((c, i) => caveats.findIndex((x) => x.code === c.code && x.message === c.message) === i);
  const root = spans.find((s) => s.kind === 'request');
  const summary = summarize(spans, root);
  summary.title = saveSpan.name;

  return {
    save,
    trace: { key: traceKey, anchor: { ...record, exact: true }, spans, links, caveats: uniqueCaveats, summary },
    correlationId: op?.correlationId ?? null,
    correlationConfidence: op?.score ?? null,
    flows,
  };
}

const GUID_IN_TEXT = /\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i;
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/i;

/**
 * Reads a record reference from what a user pastes: a model-driven app URL (`etn` and `id`),
 * "table:id", "table id", or a bare id (table unknown). Returns null when there's no id.
 */
export function parseRecordInput(text: string): { table: string | null; id: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    // Query and hash parameters (some app URLs carry them in the hash).
    const params = new Map<string, string>();
    for (const part of trimmed.split(/[?#&]/).slice(1)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const key = part.slice(0, eq).toLowerCase();
      let value = part.slice(eq + 1);
      try {
        value = decodeURIComponent(value);
      } catch {
        // Keep it as typed.
      }
      if (!params.has(key)) params.set(key, value);
    }
    const id = GUID_IN_TEXT.exec(params.get('id') ?? '')?.[1];
    if (!id) return null;
    const table = params.get('etn');
    return { table: table && TABLE_NAME.test(table) ? table.toLowerCase() : null, id: id.toLowerCase() };
  }
  const match = /^([a-z_][a-z0-9_]*)?[\s:/,]*\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i.exec(trimmed);
  if (!match) return null;
  return { table: match[1] ? match[1].toLowerCase() : null, id: match[2]!.toLowerCase() };
}
