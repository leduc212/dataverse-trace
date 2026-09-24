// A small OData v4 query engine over plain objects. Two users:
//  - the demo's mock Web API (packages/demo), which answers the app's own queries;
//  - flow trigger filter expressions (`subscriptionRequest/filterexpression`), evaluated against a
//    record to explain whether a flow should have fired.
//
//   resource:  entityset | Function | entityset(<key>)/navigation | entityset(<key>)/Namespace.Function
//   options:   $select, $filter, $orderby, $top, $expand (names only), $skiptoken (our own offsets)
//   $filter:   eq ne gt ge lt le, and / or / not, parentheses, contains/startswith/endswith,
//              Microsoft.Dynamics.CRM.In(...), lookup paths (a/b)
//   literals:  'string', number, true/false/null, GUIDs and ISO timestamps (unquoted)

export type Row = Record<string, unknown>;

export type Literal =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'guid'; value: string }
  | { kind: 'date'; value: number };

export type Expr =
  | { type: 'and' | 'or'; left: Expr; right: Expr }
  | { type: 'not'; operand: Expr }
  | { type: 'compare'; field: string; op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le'; value: Literal }
  | { type: 'in'; field: string; values: Literal[] }
  | { type: 'text'; fn: 'contains' | 'startswith' | 'endswith'; field: string; value: string };

export interface ParsedRequest {
  resource: string;
  /** For `entityset(key)/…`. */
  key?: string;
  /** Navigation property or bound function after the key. */
  navigation?: string;
  select?: string[];
  filter?: Expr;
  orderBy?: Array<{ field: string; desc: boolean }>;
  top?: number;
  expand?: string[];
  skip: number;
  /** The raw query parameters, to rebuild a next link. */
  params: Array<[string, string]>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

/** Splits on `sep` at parenthesis/bracket depth 0, outside quotes. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    else if (!quoted && (ch === '(' || ch === '[')) depth++;
    else if (!quoted && (ch === ')' || ch === ']')) depth--;
    if (ch === sep && depth === 0 && !quoted) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

// ── $filter parser ───────────────────────────────────────────────────────────

type Token = { t: 'lp' | 'rp' | 'lb' | 'rb' | 'comma' | 'eqsign' } | { t: 'str'; v: string } | { t: 'word'; v: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) i++;
    else if (ch === '(') (tokens.push({ t: 'lp' }), i++);
    else if (ch === ')') (tokens.push({ t: 'rp' }), i++);
    else if (ch === '[') (tokens.push({ t: 'lb' }), i++);
    else if (ch === ']') (tokens.push({ t: 'rb' }), i++);
    else if (ch === ',') (tokens.push({ t: 'comma' }), i++);
    else if (ch === '=') (tokens.push({ t: 'eqsign' }), i++);
    else if (ch === "'" || ch === '"') {
      const quote = ch;
      let v = '';
      i++;
      while (i < input.length) {
        if (input[i] === quote && input[i + 1] === quote) {
          v += quote;
          i += 2;
        } else if (input[i] === quote) {
          i++;
          break;
        } else v += input[i++];
      }
      tokens.push({ t: 'str', v });
    } else {
      const m = /^[A-Za-z0-9_.:+\-/@]+/.exec(input.slice(i));
      if (!m) throw new Error(`Unexpected character "${ch}" in $filter`);
      tokens.push({ t: 'word', v: m[0] });
      i += m[0].length;
    }
  }
  return tokens;
}

function literalOf(token: Token): Literal {
  if (token.t === 'str') return { kind: 'string', value: token.v };
  if (token.t !== 'word') throw new Error('Expected a literal in $filter');
  const v = token.v;
  if (v === 'null') return { kind: 'null' };
  if (v === 'true' || v === 'false') return { kind: 'bool', value: v === 'true' };
  if (GUID.test(v)) return { kind: 'guid', value: v.toLowerCase() };
  if (DATE.test(v)) return { kind: 'date', value: Date.parse(v) };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { kind: 'number', value: Number(v) };
  throw new Error(`Unsupported literal "${v}" in $filter`);
}

const TEXT_FUNCTIONS = new Set(['contains', 'startswith', 'endswith']);

export function parseFilter(input: string): Expr {
  const tokens = lex(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t: Token['t']) => {
    const tok = next();
    if (!tok || tok.t !== t) throw new Error(`Expected ${t} in $filter`);
    return tok;
  };
  const isWord = (v: string) => {
    const tok = peek();
    return tok?.t === 'word' && tok.v.toLowerCase() === v;
  };

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (isWord('or')) {
      next();
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): Expr => {
    let left = parseUnary();
    while (isWord('and')) {
      next();
      left = { type: 'and', left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): Expr => {
    if (isWord('not')) {
      next();
      return { type: 'not', operand: parseUnary() };
    }
    const tok = peek();
    if (tok?.t === 'lp') {
      next();
      const inner = parseOr();
      expect('rp');
      return inner;
    }
    if (tok?.t === 'word' && TEXT_FUNCTIONS.has(tok.v.toLowerCase()) && tokens[pos + 1]?.t === 'lp') {
      next();
      expect('lp');
      const field = next();
      expect('comma');
      const value = next();
      expect('rp');
      if (field?.t !== 'word' || value?.t !== 'str') throw new Error(`${tok.v}() expects (field, 'text')`);
      return { type: 'text', fn: tok.v.toLowerCase() as 'contains', field: field.v, value: value.v };
    }
    if (tok?.t === 'word' && /^Microsoft\.Dynamics\.CRM\.In$/i.test(tok.v)) {
      next();
      expect('lp');
      let field = '';
      let values: Literal[] = [];
      while (peek() && peek()!.t !== 'rp') {
        const name = next();
        if (name?.t !== 'word') throw new Error('Expected a parameter name in In()');
        expect('eqsign');
        if (name.v === 'PropertyName') {
          const v = next();
          if (v?.t !== 'str') throw new Error('PropertyName must be a string');
          field = v.v;
        } else if (name.v === 'PropertyValues') {
          expect('lb');
          values = [];
          while (peek() && peek()!.t !== 'rb') {
            const lit = literalOf(next()!);
            // In() passes GUIDs as quoted strings.
            values.push(lit.kind === 'string' && GUID.test(lit.value) ? { kind: 'guid', value: lit.value.toLowerCase() } : lit);
            if (peek()?.t === 'comma') next();
          }
          expect('rb');
        } else throw new Error(`Unknown In() parameter ${name.v}`);
        if (peek()?.t === 'comma') next();
      }
      expect('rp');
      return { type: 'in', field, values };
    }
    const field = next();
    const op = next();
    const value = next();
    if (field?.t !== 'word' || op?.t !== 'word' || !value) throw new Error('Expected "<field> <op> <value>" in $filter');
    const o = op.v.toLowerCase();
    if (!['eq', 'ne', 'gt', 'ge', 'lt', 'le'].includes(o)) throw new Error(`Unsupported operator ${op.v}`);
    return { type: 'compare', field: field.v, op: o as 'eq', value: literalOf(value) };
  };

  const expr = parseOr();
  if (pos !== tokens.length) throw new Error('Unexpected trailing tokens in $filter');
  return expr;
}

// ── evaluation ───────────────────────────────────────────────────────────────

/** Reads `a` or a lookup path `a/b` from a row. */
export function readField(row: Row, field: string): unknown {
  if (!field.includes('/')) return row[field];
  let value: unknown = row;
  for (const part of field.split('/')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Row)[part];
  }
  return value;
}

function compareValues(actual: unknown, literal: Literal): number | null {
  if (literal.kind === 'null') return actual === null || actual === undefined ? 0 : null;
  if (actual === null || actual === undefined) return null;
  switch (literal.kind) {
    case 'date': {
      const t = typeof actual === 'string' ? Date.parse(actual) : typeof actual === 'number' ? actual : NaN;
      return Number.isNaN(t) ? null : Math.sign(t - literal.value);
    }
    case 'number': {
      const n = typeof actual === 'number' ? actual : typeof actual === 'string' && actual.trim() !== '' ? Number(actual) : NaN;
      return Number.isNaN(n) ? null : Math.sign(n - literal.value);
    }
    case 'bool':
      return typeof actual === 'boolean' ? (actual === literal.value ? 0 : 1) : null;
    case 'guid':
    case 'string': {
      const a = String(actual).toLowerCase();
      const b = literal.value.toLowerCase();
      return a < b ? -1 : a > b ? 1 : 0;
    }
  }
}

/** Evaluates with missing fields treated as null (OData semantics). */
export function evaluate(expr: Expr, row: Row): boolean {
  switch (expr.type) {
    case 'and':
      return evaluate(expr.left, row) && evaluate(expr.right, row);
    case 'or':
      return evaluate(expr.left, row) || evaluate(expr.right, row);
    case 'not':
      return !evaluate(expr.operand, row);
    case 'in':
      return expr.values.some((v) => compareValues(readField(row, expr.field), v) === 0);
    case 'text': {
      const actual = readField(row, expr.field);
      if (typeof actual !== 'string') return false;
      const a = actual.toLowerCase();
      const b = expr.value.toLowerCase();
      return expr.fn === 'contains' ? a.includes(b) : expr.fn === 'startswith' ? a.startsWith(b) : a.endsWith(b);
    }
    case 'compare': {
      const c = compareValues(readField(row, expr.field), expr.value);
      if (expr.op === 'ne') return c !== 0;
      if (c === null) return false;
      return expr.op === 'eq' ? c === 0 : expr.op === 'gt' ? c > 0 : expr.op === 'ge' ? c >= 0 : expr.op === 'lt' ? c < 0 : c <= 0;
    }
  }
}

/** Every field an expression reads. */
export function referencedFields(expr: Expr): string[] {
  switch (expr.type) {
    case 'and':
    case 'or':
      return [...new Set([...referencedFields(expr.left), ...referencedFields(expr.right)])];
    case 'not':
      return referencedFields(expr.operand);
    default:
      return [expr.field];
  }
}

export type TriState = true | false | 'unknown';

/**
 * Evaluates a filter against a partial record: when a field it reads isn't in `row` at all (we
 * don't know its value), the answer is 'unknown' instead of guessing. Parse errors → 'unknown'.
 */
export function evaluateKnown(filter: string, row: Row): { result: TriState; missing: string[]; error?: string } {
  let expr: Expr;
  try {
    expr = parseFilter(filter);
  } catch (e) {
    return { result: 'unknown', missing: [], error: e instanceof Error ? e.message : String(e) };
  }
  const missing = referencedFields(expr).filter((f) => readField(row, f) === undefined);
  if (missing.length) return { result: 'unknown', missing };
  return { result: evaluate(expr, row), missing: [] };
}

// ── request parsing (for the mock Web API) ───────────────────────────────────

export function parseRequest(path: string): ParsedRequest {
  const relative = path.replace(/^https?:\/\/[^/]+\/api\/data\/v9\.\d\//i, '').replace(/^\//, '');
  const q = relative.indexOf('?');
  const resourcePart = q < 0 ? relative : relative.slice(0, q);
  const query = q < 0 ? '' : relative.slice(q + 1);
  const params: Array<[string, string]> = query
    ? query.split('&').map((pair) => {
        const eq = pair.indexOf('=');
        return [decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1))];
      })
    : [];

  const nav = /^([A-Za-z_]+)\(([^)]+)\)(?:\/([A-Za-z_.]+))?$/.exec(resourcePart);
  const request: ParsedRequest = { resource: nav ? nav[1]! : resourcePart, skip: 0, params };
  if (nav) {
    request.key = nav[2]!.replace(/'/g, '').replace(/^LogicalName=/i, '').toLowerCase();
    if (nav[3]) request.navigation = nav[3];
  }
  for (const [key, value] of params) {
    switch (key) {
      case '$select':
        request.select = value.split(',').map((s) => s.trim());
        break;
      case '$filter':
        request.filter = parseFilter(value);
        break;
      case '$orderby':
        request.orderBy = value.split(',').map((part) => {
          const [field, dir] = part.trim().split(/\s+/);
          return { field: field!, desc: dir?.toLowerCase() === 'desc' };
        });
        break;
      case '$top':
        request.top = Number(value);
        break;
      case '$expand':
        request.expand = splitTopLevel(value, ',').map((e) => e.replace(/\(.*$/, '').trim());
        break;
      case '$skiptoken':
        request.skip = Number(value);
        break;
      default:
        throw new Error(`Unsupported query option ${key}`);
    }
  }
  return request;
}

const ANNOTATION = '@';

/** Applies $select/$expand and strips annotations when they weren't requested. */
export function project(row: Row, request: ParsedRequest, annotations: boolean): Row {
  const out: Row = {};
  const keep = (column: string) => {
    out[column] = row[column] ?? null;
    if (!annotations) return;
    for (const key of Object.keys(row)) if (key.startsWith(`${column}${ANNOTATION}`)) out[key] = row[key];
  };
  if (request.select) request.select.forEach(keep);
  else for (const key of Object.keys(row)) if (!key.includes(ANNOTATION) && (typeof row[key] !== 'object' || row[key] === null)) keep(key);
  for (const nav of request.expand ?? []) out[nav] = row[nav] ?? null;
  return out;
}

export function sortRows(rows: Row[], orderBy: ParsedRequest['orderBy']): Row[] {
  if (!orderBy?.length) return rows;
  return [...rows].sort((a, b) => {
    for (const { field, desc } of orderBy) {
      const x = a[field];
      const y = b[field];
      if (x === y) continue;
      if (x === null || x === undefined) return desc ? 1 : -1;
      if (y === null || y === undefined) return desc ? -1 : 1;
      const c = (x as string | number) < (y as string | number) ? -1 : 1;
      return desc ? -c : c;
    }
    return 0;
  });
}
