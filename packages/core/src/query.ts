// The explorer's query language, e.g.  table:account msg:Update dur>2s err -type:Audit "NullReference"
//
//   table:  msg: / message:  type:  step:  corr: / correlation:  req: / request:  mode:sync|async
//   depth / dur / duration with : = > >= < <=   (durations accept ms, s, m suffixes)
//   err / is:error / is:ok      a leading "-" negates any clause
//   bare words and "quoted phrases" search type, message, table, exception (and trace text in the worker)
import type { TraceLogRecord } from './records.ts';

export type Field = 'table' | 'message' | 'type' | 'step' | 'correlation' | 'request' | 'mode' | 'depth' | 'duration' | 'status';
export type Op = 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

export interface Clause {
  field: Field;
  op: Op;
  value: string | number;
  negate: boolean;
}

export interface ParsedQuery {
  clauses: Clause[];
  /** Lower-cased free-text terms; all must match. */
  text: string[];
  /** Human-readable problems (unknown keys, bad numbers). The rest of the query still applies. */
  errors: string[];
}

const ALIASES: Record<string, Field> = {
  table: 'table',
  entity: 'table',
  msg: 'message',
  message: 'message',
  type: 'type',
  plugin: 'type',
  step: 'step',
  corr: 'correlation',
  correlation: 'correlation',
  req: 'request',
  request: 'request',
  mode: 'mode',
  depth: 'depth',
  dur: 'duration',
  duration: 'duration',
  is: 'status',
};

const NUMERIC: ReadonlySet<Field> = new Set(['depth', 'duration']);
const EXACT: ReadonlySet<Field> = new Set(['table', 'message', 'step', 'correlation', 'request', 'mode', 'status']);

/** Splits on whitespace, keeping "quoted phrases" (including key:"quoted value") together. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /-?[^\s"]*"[^"]*"?|\S+/g;
  for (const m of input.matchAll(re)) tokens.push(m[0]);
  return tokens;
}

const unquote = (s: string) => s.replace(/^"/, '').replace(/"$/, '');

/** Parses "250", "250ms", "2s", "1.5s", "2m" into milliseconds. */
export function parseDurationMs(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  return unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
}

export function parseQuery(input: string): ParsedQuery {
  const result: ParsedQuery = { clauses: [], text: [], errors: [] };
  for (const raw of tokenize(input)) {
    const negate = raw.startsWith('-') && raw.length > 1;
    const token = negate ? raw.slice(1) : raw;
    const lower = token.toLowerCase();
    if (lower === 'err' || lower === 'error' || lower === 'errors') {
      result.clauses.push({ field: 'status', op: 'eq', value: 'error', negate });
      continue;
    }
    const m = /^([a-z]+)(>=|<=|:|=|>|<)(.*)$/i.exec(token);
    if (!m || m[1]!.startsWith('"')) {
      const text = unquote(token).toLowerCase();
      if (text) result.text.push(text);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const field = ALIASES[key];
    const value = unquote(m[3]!);
    if (!field) {
      result.errors.push(`Unknown filter "${key}"`);
      continue;
    }
    if (value === '') {
      result.errors.push(`"${key}" needs a value`);
      continue;
    }
    const opSymbol = m[2]!;
    if (NUMERIC.has(field)) {
      const n = field === 'duration' ? parseDurationMs(value) : Number(value);
      if (n === null || !Number.isFinite(n)) {
        result.errors.push(`"${value}" isn't a number for ${key}`);
        continue;
      }
      const op: Op = opSymbol === '>' ? 'gt' : opSymbol === '>=' ? 'gte' : opSymbol === '<' ? 'lt' : opSymbol === '<=' ? 'lte' : 'eq';
      result.clauses.push({ field, op, value: n, negate });
      continue;
    }
    if (opSymbol !== ':' && opSymbol !== '=') {
      result.errors.push(`"${key}" doesn't support ${opSymbol}`);
      continue;
    }
    if (field === 'status' && !['error', 'ok'].includes(value.toLowerCase())) {
      result.errors.push(`is: expects "error" or "ok"`);
      continue;
    }
    if (field === 'mode' && !['sync', 'async'].includes(value.toLowerCase())) {
      result.errors.push(`mode: expects "sync" or "async"`);
      continue;
    }
    result.clauses.push({ field, op: EXACT.has(field) ? 'eq' : 'contains', value: value.toLowerCase(), negate });
  }
  return result;
}

function fieldValue(log: TraceLogRecord, field: Field): string | number | null {
  switch (field) {
    case 'table':
      return log.primaryEntity?.toLowerCase() ?? null;
    case 'message':
      return log.messageName.toLowerCase();
    case 'type':
      return log.typeName.toLowerCase();
    case 'step':
      return log.stepId?.toLowerCase() ?? null;
    case 'correlation':
      return log.correlationId?.toLowerCase() ?? null;
    case 'request':
      return log.requestId?.toLowerCase() ?? null;
    case 'mode':
      return log.mode;
    case 'depth':
      return log.depth;
    case 'duration':
      return log.durationMs;
    case 'status':
      return log.exception ? 'error' : 'ok';
  }
}

function clauseMatches(log: TraceLogRecord, clause: Clause): boolean {
  const actual = fieldValue(log, clause.field);
  let hit: boolean;
  if (actual === null) hit = false;
  else if (typeof clause.value === 'number' && typeof actual === 'number') {
    const v = clause.value;
    hit =
      clause.op === 'gt' ? actual > v : clause.op === 'gte' ? actual >= v : clause.op === 'lt' ? actual < v : clause.op === 'lte' ? actual <= v : actual === v;
  } else if (clause.op === 'contains') hit = String(actual).includes(String(clause.value));
  else hit = String(actual) === String(clause.value);
  return clause.negate ? !hit : hit;
}

/** Lower-cased text the free-text terms search, apart from trace text (the worker adds that). */
export const searchableText = (log: TraceLogRecord): string =>
  `${log.typeName}\n${log.messageName}\n${log.primaryEntity ?? ''}\n${log.exception ?? ''}\n${log.correlationId ?? ''}`.toLowerCase();

/**
 * True when the record matches every clause and every free-text term. `extraText` lets callers
 * include text that isn't on the record (the trace text blob).
 */
export function matchesQuery(log: TraceLogRecord, query: ParsedQuery, extraText?: string): boolean {
  for (const clause of query.clauses) if (!clauseMatches(log, clause)) return false;
  if (query.text.length === 0) return true;
  const haystack = extraText ? `${searchableText(log)}\n${extraText.toLowerCase()}` : searchableText(log);
  return query.text.every((t) => haystack.includes(t));
}

/** True when a query can be answered without reading trace text blobs. */
export const needsBlobText = (query: ParsedQuery): boolean => query.text.length > 0;
