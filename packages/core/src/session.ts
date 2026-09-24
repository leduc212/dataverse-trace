// Session files (.dvtrace.json): a trace or record story that can be shared with someone who
// can't open the environment. Imports are untrusted: they're validated here and only ever shown
// as text. Redaction runs before export and is consistent (the same value always gets the same
// placeholder), so links between spans still work after redaction.
import type { ExpectedItem } from './expected.ts';
import type { Span, SpanLink, Trace } from './model.ts';
import type { StepRegistration } from './records.ts';

export const SESSION_FORMAT = 'dataverse-trace-session';
export const SESSION_VERSION = 1;
/** Larger files are refused on import. */
export const MAX_SESSION_BYTES = 25 * 1024 * 1024;
const MAX_SPANS = 50_000;

export type SessionKind = 'trace' | 'record' | 'watch';

export interface SessionFile {
  format: typeof SESSION_FORMAT;
  version: number;
  exportedAt: number;
  appVersion: string;
  kind: SessionKind;
  title: string;
  /** Environment host, or null when redacted or unknown. */
  environment: string | null;
  trace: Trace;
  steps: Record<string, StepRegistration>;
  expected?: ExpectedItem[];
  /** Trace text by span id, when included. */
  texts?: Record<string, string>;
  /** How the file was redacted (null = not redacted). */
  redaction: RedactionOptions | null;
}

export interface RedactionOptions {
  /** keep, mask emails/GUIDs/long numbers, or leave trace text out. */
  traceText: 'keep' | 'mask' | 'remove';
  /** Replace every GUID (record, user, correlation and row ids) with a stable placeholder. */
  ids: boolean;
  /** Replace user names with "User 1", "User 2", … */
  users: boolean;
  /** Replace record names with "Record 1", … */
  records: boolean;
  /** Leave out the environment's host name. */
  environment: boolean;
}

export const DEFAULT_REDACTION: RedactionOptions = { traceText: 'mask', ids: true, users: true, records: true, environment: true };
export const NO_REDACTION: RedactionOptions = { traceText: 'keep', ids: false, users: false, records: false, environment: false };

export function createSession(p: Omit<SessionFile, 'format' | 'version' | 'redaction'>): SessionFile {
  return { format: SESSION_FORMAT, version: SESSION_VERSION, redaction: null, ...p };
}

/** Values that identify people and records, which the trace itself doesn't label. */
export interface SensitiveValues {
  users: string[];
  records: string[];
}

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_NUMBER_RE = /\b\d[\d.,]{3,}\d\b/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Masks emails, GUIDs and long numbers in free text. */
export function maskText(text: string): string {
  return text.replace(EMAIL_RE, '[email]').replace(GUID_RE, '[guid]').replace(LONG_NUMBER_RE, '[number]');
}

/**
 * Returns a redacted copy. Names are replaced wherever they appear (span names, attributes,
 * evidence, trace text); GUIDs map to stable placeholders so span ids and links stay consistent.
 */
export function redactSession(file: SessionFile, options: RedactionOptions, sensitive: SensitiveValues = { users: [], records: [] }): SessionFile {
  const copy = JSON.parse(JSON.stringify(file)) as SessionFile;
  if (copy.texts) {
    if (options.traceText === 'remove') delete copy.texts;
    else if (options.traceText === 'mask') for (const [k, v] of Object.entries(copy.texts)) copy.texts[k] = maskText(v);
  }
  const host = copy.environment;
  if (options.environment) copy.environment = null;

  const replacements: Array<[string, string]> = [];
  const add = (values: string[], label: string) =>
    [...new Set(values.filter((v) => v && v.trim().length >= 2))]
      .sort()
      .forEach((v, i) => replacements.push([v, `${label} ${i + 1}`]));
  if (options.users) add(sensitive.users, 'User');
  if (options.records) add([...sensitive.records, ...(copy.trace.anchor?.name ? [copy.trace.anchor.name] : [])], 'Record');
  if (options.environment && host) replacements.push([host, 'environment.example']);
  // Longest first, so "Jamie Ortiz" is replaced before "Jamie".
  replacements.sort((a, b) => b[0].length - a[0].length);

  let json = JSON.stringify(copy);
  for (const [from, to] of replacements) {
    const encoded = JSON.stringify(from).slice(1, -1);
    json = json.replace(new RegExp(escapeRe(encoded), 'g'), JSON.stringify(to).slice(1, -1));
  }
  if (options.ids) {
    const map = new Map<string, string>();
    json = json.replace(GUID_RE, (guid) => {
      const key = guid.toLowerCase();
      let fake = map.get(key);
      if (!fake) {
        fake = `00000000-0000-4000-8000-${(map.size + 1).toString(16).padStart(12, '0')}`;
        map.set(key, fake);
      }
      return fake;
    });
  }
  const out = JSON.parse(json) as SessionFile;
  out.redaction = options;
  return out;
}

export type SessionParseResult = { ok: true; session: SessionFile } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function checkSpan(s: unknown, i: number, errors: string[]): s is Span {
  const at = `trace.spans[${i}]`;
  if (!isObj(s)) return errors.push(`${at} is not an object`) < 0;
  const before = errors.length;
  for (const key of ['id', 'traceKey', 'kind', 'name', 'lane', 'status', 'precision'] as const) if (!isStr(s[key])) errors.push(`${at}.${key} must be text`);
  if (!isNum(s['start'])) errors.push(`${at}.start must be a number`);
  for (const key of ['end', 'queuedAt', 'depth', 'stage', 'rank'] as const) if (s[key] !== undefined && !isNum(s[key])) errors.push(`${at}.${key} must be a number`);
  if (!isObj(s['metrics'])) errors.push(`${at}.metrics must be an object`);
  if (!isObj(s['attrs'])) errors.push(`${at}.attrs must be an object`);
  else if (Object.values(s['attrs']).some((v) => !['string', 'number', 'boolean'].includes(typeof v))) errors.push(`${at}.attrs values must be text, numbers or booleans`);
  if (s['error'] !== undefined && !(isObj(s['error']) && isStr(s['error']['message']))) errors.push(`${at}.error.message must be text`);
  if (s['source'] !== null && s['source'] !== undefined && !(isObj(s['source']) && isStr(s['source']['table']) && isStr(s['source']['id']))) errors.push(`${at}.source is invalid`);
  return errors.length === before;
}

function checkLink(l: unknown, i: number, ids: Set<string>, errors: string[]): l is SpanLink {
  const at = `trace.links[${i}]`;
  if (!isObj(l)) return errors.push(`${at} is not an object`) < 0;
  const before = errors.length;
  if (!isStr(l['from']) || !ids.has(l['from'])) errors.push(`${at}.from doesn't name a span`);
  if (!isStr(l['to']) || !ids.has(l['to'])) errors.push(`${at}.to doesn't name a span`);
  if (!isStr(l['type']) || !isStr(l['rule'])) errors.push(`${at}.type and rule must be text`);
  if (!isNum(l['confidence']) || l['confidence'] < 0 || l['confidence'] > 1) errors.push(`${at}.confidence must be between 0 and 1`);
  if (!Array.isArray(l['evidence']) || l['evidence'].some((e) => !isObj(e) || !isStr(e['label']) || !isNum(e['weight']))) errors.push(`${at}.evidence is invalid`);
  return errors.length === before;
}

/** Validates an untrusted value as a session file. Reports up to 20 problems. */
export function validateSession(value: unknown): SessionParseResult {
  const errors: string[] = [];
  if (!isObj(value)) return { ok: false, errors: ['The file is not a JSON object.'] };
  if (value['format'] !== SESSION_FORMAT) return { ok: false, errors: ['This is not a Dataverse Trace session file.'] };
  if (!isNum(value['version']) || value['version'] > SESSION_VERSION) {
    return { ok: false, errors: [`Session version ${String(value['version'])} isn't supported by this version of the app.`] };
  }
  for (const key of ['appVersion', 'title'] as const) if (!isStr(value[key])) errors.push(`${key} must be text`);
  if (!['trace', 'record', 'watch'].includes(value['kind'] as string)) errors.push('kind must be trace, record or watch');
  if (!isNum(value['exportedAt'])) errors.push('exportedAt must be a number');
  if (value['environment'] !== null && !isStr(value['environment'])) errors.push('environment must be text or null');
  const trace = value['trace'];
  if (!isObj(trace) || !isStr(trace['key']) || !Array.isArray(trace['spans']) || !Array.isArray(trace['links']) || !Array.isArray(trace['caveats']) || !isObj(trace['summary'])) {
    errors.push('trace must have key, spans, links, caveats and summary');
    return { ok: false, errors };
  }
  if (trace['spans'].length > MAX_SPANS) return { ok: false, errors: [`The trace has more than ${MAX_SPANS} spans.`] };
  trace['spans'].forEach((s, i) => checkSpan(s, i, errors));
  const ids = new Set(trace['spans'].filter(isObj).map((s) => s['id'] as string));
  if (ids.size !== trace['spans'].length) errors.push('span ids must be unique');
  trace['links'].forEach((l, i) => checkLink(l, i, ids, errors));
  if (!isObj(value['steps'])) errors.push('steps must be an object');
  if (value['texts'] !== undefined && (!isObj(value['texts']) || Object.values(value['texts']).some((t) => !isStr(t)))) errors.push('texts must map span ids to text');
  if (value['expected'] !== undefined && !Array.isArray(value['expected'])) errors.push('expected must be a list');
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, session: value as unknown as SessionFile };
}

/** Parses and validates the text of a .dvtrace.json file. */
export function parseSession(text: string): SessionParseResult {
  if (text.length > MAX_SESSION_BYTES) return { ok: false, errors: [`The file is larger than ${MAX_SESSION_BYTES / 1024 / 1024} MB.`] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`The file isn't valid JSON (${e instanceof Error ? e.message : String(e)}).`] };
  }
  return validateSession(value);
}

/** File name for an export, e.g. "dvtrace-update-hp-10001-2026-09-24.dvtrace.json". */
export function sessionFileName(session: SessionFile): string {
  const slug = session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `dvtrace-${slug || session.kind}-${new Date(session.exportedAt).toISOString().slice(0, 10)}.dvtrace.json`;
}
