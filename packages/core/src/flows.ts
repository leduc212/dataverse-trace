// Cloud flow trigger definitions. A solution-aware flow's definition is stored in
// workflow.clientdata as JSON: properties.definition.triggers.<name>. The Dataverse trigger
// ("When a row is added, modified or deleted") is an OpenApiConnectionWebhook whose parameters
// are named "subscriptionRequest/…". The layout isn't formally documented (spike S3), so parsing
// is tolerant: anything unexpected gives `null` ("trigger unknown"), never a wrong answer.
import type { ChangeKind, FlowTrigger, ProcessDefinition } from './records.ts';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** subscriptionRequest/message: 1 Added, 2 Deleted, 3 Modified, 4 Added or Modified, 5 Added or Deleted, 6 Modified or Deleted, 7 all. */
export const MESSAGE_CHANGES: Record<number, ChangeKind[]> = {
  1: ['create'],
  2: ['delete'],
  3: ['update'],
  4: ['create', 'update'],
  5: ['create', 'delete'],
  6: ['update', 'delete'],
  7: ['create', 'update', 'delete'],
};

const splitColumns = (v: unknown): string[] | null => {
  if (typeof v !== 'string') return null;
  const cols = v
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return cols.length ? cols : null;
};

function triggersOf(definition: unknown): Json[] {
  if (!isObject(definition)) return [];
  const root = isObject(definition['properties']) ? definition['properties'] : definition;
  const def = isObject(root['definition']) ? root['definition'] : root;
  const triggers = def['triggers'];
  return isObject(triggers) ? Object.values(triggers).filter(isObject) : [];
}

/** Parses a flow's clientdata (string or object). Returns the first Dataverse row trigger, or null. */
export function parseFlowTrigger(clientdata: unknown): FlowTrigger | null {
  let data: unknown = clientdata;
  if (typeof clientdata === 'string') {
    try {
      data = JSON.parse(clientdata);
    } catch {
      return null;
    }
  }
  for (const trigger of triggersOf(data)) {
    const inputs = trigger['inputs'];
    const params = isObject(inputs) && isObject(inputs['parameters']) ? inputs['parameters'] : null;
    if (!params) continue;
    const table = params['subscriptionRequest/entityname'];
    const message = Number(params['subscriptionRequest/message']);
    if (typeof table !== 'string' || !MESSAGE_CHANGES[message]) continue;
    const conditions = Array.isArray(trigger['conditions'])
      ? trigger['conditions'].filter(isObject).map((c) => String(c['expression'] ?? '')).filter(Boolean)
      : [];
    const filter = params['subscriptionRequest/filterexpression'];
    const scope = Number(params['subscriptionRequest/scope']);
    return {
      table: table.toLowerCase(),
      changes: MESSAGE_CHANGES[message]!,
      filteringAttributes: splitColumns(params['subscriptionRequest/filteringattributes']),
      filterExpression: typeof filter === 'string' && filter.trim() ? filter.trim() : null,
      scope: Number.isFinite(scope) && scope > 0 ? scope : null,
      conditions,
      delayed: typeof params['subscriptionRequest/postponeuntil'] === 'string' && params['subscriptionRequest/postponeuntil'] !== '',
    };
  }
  return null;
}

/** "Create" → 'create', etc. `null` for other messages. */
export function changeKindOf(messageName: string | null | undefined): ChangeKind | null {
  switch ((messageName ?? '').toLowerCase()) {
    case 'create':
      return 'create';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    default:
      return null;
  }
}

export type ColumnMatch = { match: true | false | 'unknown'; reason: string };

/**
 * Do the changed columns satisfy a filtering-attribute list? `filtering` null means "any column".
 * Only updates are filtered; creates and deletes always pass.
 */
export function matchFilteringAttributes(change: ChangeKind, filtering: string[] | null, changed: string[] | null): ColumnMatch {
  if (change !== 'update') return { match: true, reason: `${change}s aren't filtered by columns` };
  if (filtering === null) return { match: true, reason: 'no filtering attributes: runs on any column' };
  if (changed === null) return { match: 'unknown', reason: `filters on ${filtering.join(', ')}; the changed columns aren't known` };
  const hit = filtering.filter((f) => changed.includes(f.toLowerCase()));
  return hit.length
    ? { match: true, reason: `changed ${hit.join(', ')}, which it filters on` }
    : { match: false, reason: `filters on ${filtering.join(', ')}, but the save changed ${changed.join(', ') || 'no audited columns'}` };
}

/** A live Dataverse trigger subscription (`callbackregistration`), in the terms of {@link FlowTrigger}. */
export interface TriggerSubscription {
  table: string;
  changes: ChangeKind[];
  filteringAttributes: string[] | null;
  filterExpression: string | null;
}

/** Reads a subscription from callbackregistration values. `null` when the message isn't known. */
export function toSubscription(entityName: unknown, message: unknown, filtering: unknown, filterExpression: unknown): TriggerSubscription | null {
  const changes = MESSAGE_CHANGES[Number(message)];
  if (typeof entityName !== 'string' || !changes) return null;
  return {
    table: entityName.toLowerCase(),
    changes,
    filteringAttributes: splitColumns(filtering),
    filterExpression: typeof filterExpression === 'string' && filterExpression.trim() ? filterExpression.trim() : null,
  };
}

const sameSet = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
const normalizeFilter = (f: string | null) => (f === null ? null : f.replace(/\s+/g, ' ').trim().toLowerCase());

/** Does a live subscription match this flow trigger (table, changes, columns and filter)? */
export function subscriptionMatches(trigger: FlowTrigger, sub: TriggerSubscription): boolean {
  return (
    trigger.table === sub.table &&
    sameSet(trigger.changes, sub.changes) &&
    sameSet(trigger.filteringAttributes, sub.filteringAttributes) &&
    normalizeFilter(trigger.filterExpression) === normalizeFilter(sub.filterExpression)
  );
}

/**
 * Marks each active cloud flow with whether a live subscription matches its trigger. `subs` null
 * means subscriptions couldn't be read, so nothing is claimed either way.
 */
export function annotateSubscriptions(processes: ProcessDefinition[], subs: readonly TriggerSubscription[] | null): ProcessDefinition[] {
  return processes.map((p) => {
    if (p.category !== 'flow' || !p.flowTrigger || !p.active || subs === null) return { ...p, subscription: null };
    return { ...p, subscription: subs.some((s) => subscriptionMatches(p.flowTrigger!, s)) ? 'found' : 'missing' };
  });
}
