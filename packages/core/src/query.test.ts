import { describe, expect, it } from 'vitest';
import { matchesQuery, parseDurationMs, parseQuery, tokenize } from './query.ts';
import { traceLog } from './test-builders.ts';

describe('tokenize', () => {
  it('keeps quoted phrases and key:"quoted values" together', () => {
    expect(tokenize('table:account "null reference" type:"Harbor Plugin" -err')).toEqual([
      'table:account',
      '"null reference"',
      'type:"Harbor Plugin"',
      '-err',
    ]);
  });
});

describe('parseDurationMs', () => {
  it.each([
    ['250', 250],
    ['250ms', 250],
    ['2s', 2000],
    ['1.5s', 1500],
    ['2m', 120_000],
    ['abc', null],
  ])('%s → %s', (input, expected) => expect(parseDurationMs(input)).toBe(expected));
});

describe('parseQuery', () => {
  it('parses fields, comparisons, negation and free text', () => {
    const q = parseQuery('table:Account msg:update dur>2s depth<=2 -type:Audit err "Null Ref"');
    expect(q.errors).toEqual([]);
    expect(q.text).toEqual(['null ref']);
    expect(q.clauses).toEqual([
      { field: 'table', op: 'eq', value: 'account', negate: false },
      { field: 'message', op: 'eq', value: 'update', negate: false },
      { field: 'duration', op: 'gt', value: 2000, negate: false },
      { field: 'depth', op: 'lte', value: 2, negate: false },
      { field: 'type', op: 'contains', value: 'audit', negate: true },
      { field: 'status', op: 'eq', value: 'error', negate: false },
    ]);
  });

  it('reports problems but keeps the valid parts', () => {
    const q = parseQuery('colour:red dur>fast mode:sometimes table: table>x table:contact');
    expect(q.errors).toHaveLength(5);
    expect(q.clauses).toEqual([{ field: 'table', op: 'eq', value: 'contact', negate: false }]);
  });
});

describe('matchesQuery', () => {
  const slowError = traceLog({ primaryEntity: 'account', messageName: 'Update', durationMs: 3000, depth: 2, typeName: 'Harbor.ErpSync', exception: 'System.TimeoutException: ERP timeout' });
  const fastOk = traceLog({ primaryEntity: 'contact', messageName: 'Create', durationMs: 20, depth: 1, typeName: 'Harbor.AuditLog' });

  it.each([
    ['table:account', true, false],
    ['-table:account', false, true],
    ['dur>=2s', true, false],
    ['depth:1', false, true],
    ['err', true, false],
    ['is:ok', false, true],
    ['type:erp', true, false],
    ['timeout', true, false],
    ['harbor', true, true],
    ['harbor create', false, true],
    ['mode:async', false, false],
  ])('%s', (query, first, second) => {
    const q = parseQuery(query);
    expect(matchesQuery(slowError, q)).toBe(first);
    expect(matchesQuery(fastOk, q)).toBe(second);
  });

  it('searches extra text such as the trace block', () => {
    const q = parseQuery('"loaded config"');
    expect(matchesQuery(fastOk, q)).toBe(false);
    expect(matchesQuery(fastOk, q, 'Step 1: Loaded config in 12 ms')).toBe(true);
  });
});
