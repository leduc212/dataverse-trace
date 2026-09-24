// Expected vs. actual: everything registered to run for a table + change + changed columns, in
// execution order, with whether it should have run, whether it did, and why.
import { matchFilteringAttributes } from './flows.ts';
import { evaluateKnown } from './odata.ts';
import type { ChangeKind, ProcessDefinition, StepRegistration } from './records.ts';

export type Tri = true | false | 'unknown';

export interface ExpectedItem {
  kind: 'step' | 'workflow' | 'businessRule' | 'flow';
  id: string;
  name: string;
  /** Where it runs, e.g. "Pre-validation · order 1", "Async step", "Cloud flow". */
  phase: string;
  sortKey: number;
  shouldRun: Tri;
  /** Why it should or shouldn't run. */
  reasons: string[];
  ran: 'yes' | 'no' | 'unknown';
  ranDetail: string;
  /** For inferred matches (flows). */
  confidence: number | null;
  spanIds: string[];
}

/** What was actually observed for one save. Omit it to list expectations only. */
export interface Observed {
  /** Step id → span ids that ran. */
  steps: ReadonlyMap<string, string[]>;
  /** Workflow activation ids of system jobs in the operation. */
  workflowActivationIds: ReadonlySet<string>;
  /** Flow (process) id → linked run span and confidence. */
  flows: ReadonlyMap<string, { spanId: string; confidence: number }>;
  /** Organization trace setting: 0 Off, 1 Exceptions, 2 All. */
  traceSetting: 0 | 1 | 2 | null;
}

export interface ExpectedInput {
  table: string;
  change: ChangeKind;
  changedColumns: string[] | null;
  steps: readonly StepRegistration[];
  processes: readonly ProcessDefinition[];
  /** Record values for flow filter expressions (may be partial). */
  recordValues?: Record<string, unknown>;
  observed?: Observed;
}

const STAGE_PHASE: Record<number, string> = { 10: 'Pre-validation', 20: 'Pre-operation', 30: 'Main operation', 40: 'Post-operation' };
const MESSAGE: Record<ChangeKind, string> = { create: 'Create', update: 'Update', delete: 'Delete' };

function notSeen(item: ExpectedItem, observed: Observed | undefined, canTrace: boolean): Pick<ExpectedItem, 'ran' | 'ranDetail'> {
  if (item.shouldRun === false) return { ran: 'no', ranDetail: 'not expected to run' };
  if (!observed) return { ran: 'unknown', ranDetail: 'no save selected' };
  if (!canTrace) return { ran: 'unknown', ranDetail: 'runs without leaving a trace' };
  if (observed.traceSetting === 0) return { ran: 'unknown', ranDetail: 'trace logging is Off' };
  if (observed.traceSetting === 1) return { ran: 'unknown', ranDetail: 'only failures are logged (trace setting Exceptions)' };
  return { ran: 'no', ranDetail: 'expected, but no trace was found (bypassed, or its logs weren\'t synced before Dataverse deleted them)' };
}

export function expectedFor(input: ExpectedInput): ExpectedItem[] {
  const { table, change, changedColumns, observed } = input;
  const items: ExpectedItem[] = [];

  // Plugin steps: sync ones by stage and order, then async.
  for (const s of input.steps) {
    if (s.messageName !== MESSAGE[change]) continue;
    if (s.primaryEntity !== null && s.primaryEntity !== table) continue;
    const reasons: string[] = [];
    let shouldRun: Tri = true;
    if (!s.enabled) {
      shouldRun = false;
      reasons.push('the step is disabled');
    } else {
      const m = matchFilteringAttributes(change, s.filteringAttributes, changedColumns);
      shouldRun = m.match;
      reasons.push(m.reason);
      if (s.primaryEntity === null) reasons.push('registered for all tables');
    }
    const phase = s.mode === 'async' ? 'Async step' : `${STAGE_PHASE[s.stage] ?? `Stage ${s.stage}`} · order ${s.rank}`;
    const item: ExpectedItem = {
      kind: 'step',
      id: s.id,
      name: s.pluginTypeName ?? s.name,
      phase,
      sortKey: (s.mode === 'async' ? 100 : s.stage) * 1000 + s.rank,
      shouldRun,
      reasons,
      ran: 'unknown',
      ranDetail: '',
      confidence: null,
      spanIds: [],
    };
    const seen = observed?.steps.get(s.id);
    if (seen?.length) Object.assign(item, { ran: 'yes', ranDetail: seen.length > 1 ? `ran ${seen.length} times` : 'ran', spanIds: seen });
    else Object.assign(item, notSeen(item, observed, true));
    items.push(item);
  }

  for (const p of input.processes) {
    if (p.category === 'flow') {
      const t = p.flowTrigger;
      if (!t || t.table !== table || !t.changes.includes(change)) continue;
      const reasons: string[] = [];
      let shouldRun: Tri = true;
      if (!p.active) {
        shouldRun = false;
        reasons.push('the flow is turned off');
      } else {
        const m = matchFilteringAttributes(change, t.filteringAttributes, changedColumns);
        shouldRun = m.match;
        reasons.push(m.reason);
        if (shouldRun !== false && t.filterExpression) {
          const f = evaluateKnown(t.filterExpression, input.recordValues ?? {});
          reasons.push(f.result === 'unknown' ? `filter "${t.filterExpression}" couldn't be checked` : `filter "${t.filterExpression}" is ${f.result}`);
          if (f.result === false) shouldRun = false;
          else if (f.result === 'unknown' && shouldRun === true) shouldRun = 'unknown';
        }
        if (shouldRun !== false && t.conditions.length) {
          reasons.push(`${t.conditions.length} trigger condition(s) can't be checked`);
          if (shouldRun === true) shouldRun = 'unknown';
        }
        if (shouldRun !== false && p.subscription === 'missing') {
          reasons.push('no live trigger subscription matches this trigger (the flow may be broken or its connection expired)');
          shouldRun = 'unknown';
        }
      }
      const item: ExpectedItem = { kind: 'flow', id: p.id, name: p.name, phase: 'Cloud flow', sortKey: 300_000, shouldRun, reasons, ran: 'unknown', ranDetail: '', confidence: null, spanIds: [] };
      const run = observed?.flows.get(p.id);
      if (run) Object.assign(item, { ran: 'yes', ranDetail: `linked run (${Math.round(run.confidence * 100)} % confidence)`, confidence: run.confidence, spanIds: [run.spanId] });
      else if (shouldRun === false) Object.assign(item, { ran: 'no', ranDetail: 'not expected to run' });
      else Object.assign(item, { ran: 'unknown', ranDetail: observed ? 'no matching run found (flow run history can be late or incomplete)' : 'no save selected' });
      items.push(item);
      continue;
    }
    if (p.primaryEntity !== table) continue;
    if (p.category === 'workflow') {
      const reasons: string[] = [];
      let shouldRun: Tri;
      if (!p.active) {
        shouldRun = false;
        reasons.push('the workflow isn\'t activated');
      } else if (change === 'create') {
        shouldRun = p.triggerOnCreate;
        reasons.push(p.triggerOnCreate ? 'starts when a record is created' : 'doesn\'t start on create');
      } else if (change === 'delete') {
        shouldRun = p.triggerOnDelete;
        reasons.push(p.triggerOnDelete ? 'starts when a record is deleted' : 'doesn\'t start on delete');
      } else if (p.triggerOnUpdateAttributes === null) {
        shouldRun = false;
        reasons.push('doesn\'t start on updates');
      } else {
        const m = matchFilteringAttributes('update', p.triggerOnUpdateAttributes, changedColumns);
        shouldRun = m.match;
        reasons.push(m.reason.replace('filters on', 'starts when these change:'));
      }
      const realtime = p.mode === 'realtime';
      const item: ExpectedItem = {
        kind: 'workflow',
        id: p.id,
        name: p.name,
        phase: realtime ? 'Real-time workflow' : 'Background workflow',
        sortKey: realtime ? 45_000 : 200_000,
        shouldRun,
        reasons,
        ran: 'unknown',
        ranDetail: '',
        confidence: null,
        spanIds: [],
      };
      const ran = observed && p.activationIds.some((id) => observed.workflowActivationIds.has(id));
      if (ran) Object.assign(item, { ran: 'yes', ranDetail: 'a system job ran for it' });
      else Object.assign(item, notSeen(item, observed, !realtime));
      items.push(item);
    } else if (p.category === 'businessRule') {
      items.push({
        kind: 'businessRule',
        id: p.id,
        name: p.name,
        phase: 'Business rule',
        sortKey: 400_000,
        shouldRun: p.active ? 'unknown' : false,
        reasons: [p.active ? 'runs in forms, and on the server only when its scope is Entity' : 'the business rule isn\'t activated'],
        ran: p.active ? 'unknown' : 'no',
        ranDetail: p.active ? 'business rules leave no trace' : 'not expected to run',
        confidence: null,
        spanIds: [],
      });
    }
  }
  return items.sort((a, b) => a.sortKey - b.sortKey || (a.name < b.name ? -1 : 1));
}
