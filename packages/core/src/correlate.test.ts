import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assembleTrace, summarizeOperations, type CorrelationInput } from './correlate.ts';
import type { StepRegistration } from './records.ts';
import { T0, asyncOp, step, traceLog } from './test-builders.ts';

const noSteps = new Map<string, StepRegistration>();
const input = (p: Partial<CorrelationInput>): CorrelationInput => ({ traceLogs: [], asyncOps: [], steps: noSteps, ...p });
const parentOf = (trace: NonNullable<ReturnType<typeof assembleTrace>>, spanId: string) =>
  trace.links.find((l) => l.to === spanId && l.type === 'childOf');

describe('assembleTrace', () => {
  it('returns null for an unknown correlation id', () => {
    expect(assembleTrace('nope', input({ traceLogs: [traceLog()] }))).toBeNull();
  });

  it('R2: groups sync rows with the same request id and depth into one request span, ordered by stage then rank', () => {
    const pre = step({ id: 's-pre', stage: 20, rank: 1 });
    const postB = step({ id: 's-postB', stage: 40, rank: 2 });
    const postA = step({ id: 's-postA', stage: 40, rank: 1 });
    const steps = new Map([pre, postB, postA].map((s) => [s.id, s]));
    const logs = [
      traceLog({ id: 'b', stepId: 's-postB', typeName: 'PostB', start: T0 }),
      traceLog({ id: 'p', stepId: 's-pre', typeName: 'Pre', start: T0 }),
      traceLog({ id: 'a', stepId: 's-postA', typeName: 'PostA', start: T0 }),
    ];
    const trace = assembleTrace('corr-1', input({ traceLogs: logs, steps }))!;
    const requests = trace.spans.filter((s) => s.kind === 'request');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.name).toBe('Update account');
    const children = trace.links.filter((l) => l.from === requests[0]!.id).map((l) => l.to);
    expect(children).toEqual(['plugintracelog:p', 'plugintracelog:a', 'plugintracelog:b']);
    expect(trace.links.every((l) => l.rule !== 'R2' || l.confidence === 1)).toBe(true);
  });

  it('R3: nests a depth-2 request under the depth-1 step whose run window contains it', () => {
    const outer = traceLog({ id: 'outer', requestId: 'r1', depth: 1, start: T0, durationMs: 1000 });
    const inner = traceLog({ id: 'inner', requestId: 'r2', depth: 2, start: T0 + 200, durationMs: 300, primaryEntity: 'contact' });
    const trace = assembleTrace('corr-1', input({ traceLogs: [outer, inner] }))!;
    const innerRequest = trace.spans.find((s) => s.kind === 'request' && s.depth === 2)!;
    const link = parentOf(trace, innerRequest.id)!;
    expect(link.from).toBe('plugintracelog:outer');
    expect(link.rule).toBe('R3');
    expect(link.confidence).toBe(1);
  });

  it('R3: with whole-second timestamps, a short sibling step cannot capture a longer nested request', () => {
    // All three steps started in the same second. Only PostCreate (110 ms) can contain the 38 ms rollup.
    const s = { precision: 's' as const, start: T0, requestId: 'r1', depth: 1 };
    const validate = traceLog({ ...s, id: 'validate', durationMs: 12 });
    const defaults = traceLog({ ...s, id: 'defaults', durationMs: 8 });
    const postCreate = traceLog({ ...s, id: 'postcreate', durationMs: 110 });
    const rollup = traceLog({ id: 'rollup', precision: 's', start: T0, requestId: 'r2', depth: 2, durationMs: 38 });
    const trace = assembleTrace('corr-1', input({ traceLogs: [validate, defaults, postCreate, rollup] }))!;
    const nested = trace.spans.find((x) => x.kind === 'request' && x.depth === 2)!;
    expect(parentOf(trace, nested.id)).toMatchObject({ from: 'plugintracelog:postcreate', confidence: 1 });
  });

  it('R3: picks the tightest window and lowers confidence when nesting is ambiguous', () => {
    const wide = traceLog({ id: 'wide', requestId: 'r1', depth: 1, start: T0, durationMs: 2000 });
    const tight = traceLog({ id: 'tight', requestId: 'r1', depth: 1, start: T0, durationMs: 600 });
    const inner = traceLog({ id: 'inner', requestId: 'r2', depth: 2, start: T0 + 100, durationMs: 100 });
    const trace = assembleTrace('corr-1', input({ traceLogs: [wide, tight, inner] }))!;
    const innerRequest = trace.spans.find((s) => s.kind === 'request' && s.depth === 2)!;
    const link = parentOf(trace, innerRequest.id)!;
    expect(link.from).toBe('plugintracelog:tight');
    expect(link.confidence).toBe(0.5);
    expect(trace.caveats.map((c) => c.code)).toContain('ambiguousNesting');
  });

  it('R4: links an async trace row to its system job, and the job to the request that queued it', () => {
    const syncLog = traceLog({ id: 'sync', requestId: 'r1', start: T0, durationMs: 50 });
    const asyncLog = traceLog({ id: 'async', mode: 'async', stepId: 'step-async', requestId: 'r9', start: T0 + 2100, durationMs: 300 });
    const job = asyncOp({ id: 'job1', stepId: 'step-async', requestId: 'r1', startedOn: T0 + 2000, completedOn: T0 + 2500 });
    const trace = assembleTrace('corr-1', input({ traceLogs: [syncLog, asyncLog], asyncOps: [job] }))!;
    expect(parentOf(trace, 'plugintracelog:async')).toMatchObject({ from: 'asyncoperation:job1', rule: 'R4', confidence: 1 });
    const queued = trace.links.find((l) => l.to === 'asyncoperation:job1')!;
    expect(queued.type).toBe('followsFrom');
    expect(queued.from).toMatch(/^request:/);
    const jobSpan = trace.spans.find((s) => s.id === 'asyncoperation:job1')!;
    expect(jobSpan.metrics.queueMs).toBe(2000);
    expect(jobSpan.lane).toBe('async');
  });

  it('R4: links a custom workflow activity to the workflow job it ran in', () => {
    const activity = traceLog({ id: 'act', mode: 'async', operationType: 'workflowActivity', stepId: null, start: T0 + 2100, durationMs: 200 });
    const wf = asyncOp({ id: 'wf', operationType: 10, operationTypeLabel: 'Workflow', stepId: null, startedOn: T0 + 2000, completedOn: T0 + 2600 });
    const plugin = asyncOp({ id: 'plugin-job', operationType: 1, stepId: 'other-step', startedOn: T0 + 2000, completedOn: T0 + 2600 });
    const trace = assembleTrace('corr-1', input({ traceLogs: [activity], asyncOps: [plugin, wf] }))!;
    expect(parentOf(trace, 'plugintracelog:act')).toMatchObject({ from: 'asyncoperation:wf', confidence: 1 });
    expect(trace.caveats.map((c) => c.code)).not.toContain('asyncJobMissing');
  });

  it('adds a caveat when an async row has no system job (auto-deleted)', () => {
    const asyncLog = traceLog({ mode: 'async', stepId: 'step-async' });
    const trace = assembleTrace('corr-1', input({ traceLogs: [asyncLog] }))!;
    expect(trace.caveats.map((c) => c.code)).toContain('asyncJobMissing');
  });

  it('R5: anchors the trace on the regarding record of the lowest-depth job for the root table', () => {
    const logs = [traceLog({ primaryEntity: 'account' })];
    const jobs = [
      asyncOp({ id: 'deep', depth: 2, regarding: { table: 'contact', id: 'c-1' } }),
      asyncOp({ id: 'root', depth: 1, regarding: { table: 'account', id: 'a-1', name: 'Contoso' } }),
    ];
    const trace = assembleTrace('corr-1', input({ traceLogs: logs, asyncOps: jobs }))!;
    expect(trace.anchor).toEqual({ table: 'account', id: 'a-1', name: 'Contoso', exact: true });
  });

  it('maps job status codes and marks failed spans as errors', () => {
    const failed = asyncOp({ id: 'f', statusCode: 31, statusLabel: 'Failed', message: 'ERP timeout', completedOn: T0 + 3000 });
    const waiting = asyncOp({ id: 'w', statusCode: 10, statusLabel: 'Waiting', startedOn: null, completedOn: null });
    const trace = assembleTrace('corr-1', input({ asyncOps: [failed, waiting] }))!;
    expect(trace.spans.find((s) => s.id === 'asyncoperation:f')).toMatchObject({ status: 'error', error: { message: 'ERP timeout' } });
    expect(trace.spans.find((s) => s.id === 'asyncoperation:w')).toMatchObject({ status: 'waiting' });
    expect(trace.summary.errors).toBe(1);
  });

  it('flags whole-second timestamps and summarises the trace', () => {
    const logs = [
      traceLog({ id: 'x', precision: 's', depth: 1, durationMs: 400, exception: 'System.Exception: boom' }),
      traceLog({ id: 'y', precision: 's', depth: 2, requestId: 'r2', durationMs: 100 }),
    ];
    const trace = assembleTrace('corr-1', input({ traceLogs: logs }))!;
    expect(trace.caveats.map((c) => c.code)).toContain('secondPrecision');
    expect(trace.summary).toMatchObject({ title: 'Update account', errors: 1, maxDepth: 2 });
    expect(trace.spans.find((s) => s.id === 'plugintracelog:x')!.error?.message).toBe('Exception: boom');
  });
});

describe('assembleTrace properties', () => {
  // Random traces: a few requests over depths 1–3 with random windows, some async rows and jobs.
  const logArb = fc.record({
    id: fc.uuid(),
    depth: fc.integer({ min: 1, max: 3 }),
    request: fc.constantFrom('r1', 'r2', 'r3', 'r4'),
    offset: fc.integer({ min: 0, max: 5000 }),
    duration: fc.integer({ min: 0, max: 3000 }),
    async: fc.boolean(),
    step: fc.constantFrom('s1', 's2', 's3'),
    precision: fc.constantFrom('ms' as const, 's' as const),
  });
  const jobArb = fc.record({ id: fc.uuid(), step: fc.constantFrom('s1', 's2', 's3'), offset: fc.integer({ min: 0, max: 5000 }) });
  const scenario = fc.record({ logs: fc.uniqueArray(logArb, { selector: (l) => l.id, minLength: 1, maxLength: 25 }), jobs: fc.uniqueArray(jobArb, { selector: (j) => j.id, maxLength: 5 }) });

  type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;
  const build = (s: ValueOf<typeof scenario>) =>
    input({
      traceLogs: s.logs.map((l) =>
        traceLog({ id: l.id, depth: l.depth, requestId: l.request, start: T0 + l.offset, durationMs: l.duration, mode: l.async ? 'async' : 'sync', stepId: l.step, precision: l.precision }),
      ),
      asyncOps: s.jobs.map((j) => asyncOp({ id: j.id, stepId: j.step, startedOn: T0 + j.offset, completedOn: T0 + j.offset + 500 })),
      now: T0 + 60_000,
    });

  it('produces the same trace regardless of input order', () => {
    fc.assert(
      fc.property(scenario, fc.integer(), (s, seed) => {
        const a = build(s);
        const shuffle = <T,>(xs: readonly T[]) => [...xs].sort((x, y) => (((JSON.stringify(x).length * 31 + seed) % 7) - ((JSON.stringify(y).length * 17 + seed) % 7)));
        const b = { ...a, traceLogs: shuffle([...a.traceLogs].reverse()), asyncOps: [...a.asyncOps].reverse() };
        expect(JSON.stringify(assembleTrace('corr-1', b))).toBe(JSON.stringify(assembleTrace('corr-1', a)));
      }),
    );
  });

  it('never gives a span two parents, never creates cycles, keeps confidence in (0, 1] and always has evidence', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const trace = assembleTrace('corr-1', build(s))!;
        const parents = new Map<string, string>();
        for (const l of trace.links.filter((x) => x.type === 'childOf')) {
          expect(parents.has(l.to)).toBe(false);
          parents.set(l.to, l.from);
        }
        for (const start of parents.keys()) {
          const seen = new Set<string>();
          let cursor: string | undefined = start;
          while (cursor) {
            expect(seen.has(cursor)).toBe(false);
            seen.add(cursor);
            cursor = parents.get(cursor);
          }
        }
        for (const l of trace.links) {
          expect(l.confidence).toBeGreaterThan(0);
          expect(l.confidence).toBeLessThanOrEqual(1);
          expect(l.evidence.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});

describe('summarizeOperations', () => {
  it('summarises each correlation, newest first', () => {
    const rows = [
      traceLog({ correlationId: 'old', start: T0, depth: 1, messageName: 'Create', primaryEntity: 'policy' }),
      traceLog({ correlationId: 'new', start: T0 + 60_000, depth: 2, primaryEntity: 'contact' }),
      traceLog({ correlationId: 'new', start: T0 + 60_000, depth: 1, exception: 'boom', primaryEntity: 'account' }),
    ];
    const ops = summarizeOperations(rows);
    expect(ops.map((o) => o.correlationId)).toEqual(['new', 'old']);
    expect(ops[0]).toMatchObject({ steps: 2, errors: 1, maxDepth: 2, title: 'Update account', tables: ['account', 'contact'] });
    expect(ops[1]!.title).toBe('Create policy');
  });
});
