import { describe, expect, it } from 'vitest';
import { assembleTrace } from './correlate.ts';
import { criticalPath, layoutWaterfall } from './layout.ts';
import type { StepRegistration, TraceLogRecord } from './records.ts';
import { T0, asyncOp, step, traceLog } from './test-builders.ts';

const steps = new Map<string, StepRegistration>(
  [step({ id: 'pre', stage: 20, rank: 1 }), step({ id: 'post1', stage: 40, rank: 1 }), step({ id: 'post2', stage: 40, rank: 2 })].map((s) => [s.id, s]),
);

const trace = (logs: TraceLogRecord[], jobs = [] as ReturnType<typeof asyncOp>[]) =>
  assembleTrace('corr-1', { traceLogs: logs, asyncOps: jobs, steps })!;

describe('layoutWaterfall', () => {
  it('orders rows depth-first: request, then its steps in pipeline order', () => {
    const layout = layoutWaterfall(
      trace([
        traceLog({ id: 'b', stepId: 'post2' }),
        traceLog({ id: 'a', stepId: 'post1' }),
        traceLog({ id: 'p', stepId: 'pre' }),
      ]),
    );
    expect(layout.rows.map((r) => [r.span.id.split(':')[0], r.level])).toEqual([
      ['request', 0],
      ['plugintracelog', 1],
      ['plugintracelog', 1],
      ['plugintracelog', 1],
    ]);
    expect(layout.rows.slice(1).map((r) => r.span.id)).toEqual(['plugintracelog:p', 'plugintracelog:a', 'plugintracelog:b']);
  });

  it('places same-second siblings one after another and marks them estimated', () => {
    const layout = layoutWaterfall(
      trace([
        traceLog({ id: 'p', stepId: 'pre', start: T0, durationMs: 100, precision: 's' }),
        traceLog({ id: 'a', stepId: 'post1', start: T0, durationMs: 300, precision: 's' }),
        traceLog({ id: 'b', stepId: 'post2', start: T0, durationMs: 50, precision: 's' }),
      ]),
    );
    const [request, p, a, b] = layout.rows;
    expect([p!.displayStart, a!.displayStart, b!.displayStart]).toEqual([T0, T0 + 100, T0 + 400]);
    expect([p!.estimated, a!.estimated, b!.estimated]).toEqual([false, true, true]);
    expect(request!.displayEnd).toBe(T0 + 450);
    expect(b!.displayEnd - b!.displayStart).toBe(50);
  });

  it('keeps recorded starts when timestamps have milliseconds', () => {
    const layout = layoutWaterfall(
      trace([
        traceLog({ id: 'p', stepId: 'pre', start: T0, durationMs: 100 }),
        traceLog({ id: 'a', stepId: 'post1', start: T0 + 20, durationMs: 300 }),
      ]),
    );
    const a = layout.rows.find((r) => r.span.id === 'plugintracelog:a')!;
    expect(a.displayStart).toBe(T0 + 20);
    expect(a.estimated).toBe(false);
  });

  it('does not stretch a request to cover the system job it queued', () => {
    const layout = layoutWaterfall(
      trace([traceLog({ id: 's', stepId: 'post1', start: T0, durationMs: 100, requestId: 'req-1' })], [asyncOp({ id: 'j', requestId: 'req-1', createdOn: T0 + 100, startedOn: T0 + 5000, completedOn: T0 + 9000 })]),
    );
    const request = layout.rows.find((r) => r.span.kind === 'request')!;
    const job = layout.rows.find((r) => r.span.id === 'asyncoperation:j')!;
    expect(request.displayEnd).toBe(T0 + 100);
    expect(job.parentId).toBe(request.span.id);
    expect(job.displayStart).toBe(T0 + 5000);
  });

  it('stretches a whole-second job to cover the activity it ran', () => {
    const layout = layoutWaterfall(
      assembleTrace('corr-1', {
        traceLogs: [traceLog({ id: 'act', mode: 'async', operationType: 'workflowActivity', start: T0 + 3000, durationMs: 152, precision: 's' })],
        asyncOps: [asyncOp({ id: 'wf', operationType: 10, startedOn: T0 + 3000, completedOn: T0 + 3000, precision: 's' })],
        steps,
      })!,
    );
    const job = layout.rows.find((r) => r.span.id === 'asyncoperation:wf')!;
    expect(job.displayEnd - job.displayStart).toBe(152);
    expect(job.estimated).toBe(true);
  });

  it('includes the queue time of system jobs in the overall range', () => {
    const layout = layoutWaterfall(
      trace([traceLog({ id: 's', start: T0 + 1000 })], [asyncOp({ id: 'j', createdOn: T0 + 500, startedOn: T0 + 3000, completedOn: T0 + 3500 })]),
    );
    expect(layout.start).toBe(T0 + 500);
    expect(layout.end).toBe(T0 + 3500);
  });
});

describe('layoutWaterfall with record stories', () => {
  it('puts the save first, with the operation and flow runs it triggered underneath on their own clocks', async () => {
    const { buildRecordStory, findSaves } = await import('./record.ts');
    const { audit, flowProcess, flowRun } = await import('./test-builders.ts');
    const inp = {
      record: { table: 'account', id: 'rec-1' },
      audits: [audit({ createdOn: T0 + 50 })],
      traceLogs: [traceLog({ correlationId: 'c1', start: T0, durationMs: 100 })],
      asyncOps: [],
      flowRuns: [flowRun({ id: 'r', start: T0 + 4000 })],
      processes: [flowProcess()],
      steps,
    };
    const story = buildRecordStory(findSaves(inp)[0]!, inp);
    const layout = layoutWaterfall(story.trace);
    expect(layout.rows[0]!.span.kind).toBe('audit');
    const flow = layout.rows.find((r) => r.span.kind === 'flowRun')!;
    expect(flow.parentId).toBe(layout.rows[0]!.span.id);
    expect(flow.displayStart).toBe(T0 + 4000);
    expect(flow.linkConfidence).toBeLessThan(1);
    const request = layout.rows.find((r) => r.span.kind === 'request')!;
    expect(request.parentId).toBe(layout.rows[0]!.span.id);
    // Audited at commit (T0 + 50), but the pipeline it belongs to started at T0.
    expect(request.displayStart).toBe(T0);
    expect(request.estimated).toBe(false);
  });
});

describe('criticalPath', () => {
  const H = 1000;

  it('follows the step that kept the save waiting, and the nested request inside it', () => {
    // Pre-op 100 ms, then post-op 1 (3 s, which runs a nested request of 2 s), then post-op 2 (50 ms).
    const layout = layoutWaterfall(
      trace([
        traceLog({ id: 'p', stepId: 'pre', requestId: 'r1', start: T0, durationMs: 100, precision: 'ms' }),
        traceLog({ id: 'a', stepId: 'post1', requestId: 'r1', start: T0 + 100, durationMs: 3 * H, precision: 'ms' }),
        traceLog({ id: 'b', stepId: 'post2', requestId: 'r1', start: T0 + 3100, durationMs: 50, precision: 'ms' }),
        traceLog({ id: 'n', requestId: 'r2', depth: 2, start: T0 + 500, durationMs: 2 * H, precision: 'ms' }),
      ]),
    );
    const path = criticalPath(layout);
    const ids = path.spanIds.map((id) => id.replace(/^plugintracelog:/, ''));
    // The request, then (walking back from the end) b, a with its nested request, and p.
    expect(ids[0]).toMatch(/^request:/);
    expect(ids.filter((id) => !id.startsWith('request:'))).toEqual(['b', 'a', 'n', 'p']);
    expect(path.wallMs).toBe(3150);
    // a spent 3 s, of which 2 s were its nested request's step: 1 s is its own.
    const share = Object.fromEntries(path.segments.map((s) => [s.spanId.replace(/^plugintracelog:/, ''), s.selfMs]));
    expect(share).toMatchObject({ n: 2000, a: 1000, p: 100, b: 50 });
    expect(path.segments.reduce((sum, s) => sum + s.selfMs + s.queueMs, 0)).toBe(path.wallMs);
  });

  it('goes through the system job when it finishes last, then back to what ran before it was queued', () => {
    const layout = layoutWaterfall(
      trace(
        [traceLog({ id: 's', stepId: 'pre', requestId: 'r1', start: T0, durationMs: 40, precision: 'ms' })],
        [asyncOp({ id: 'job', requestId: 'r1', createdOn: T0 + 50, startedOn: T0 + 2000, completedOn: T0 + 9000, modifiedOn: T0 + 9000 })],
      ),
    );
    const path = criticalPath(layout);
    expect(path.spanIds.map((id) => id.split(':')[0])).toEqual(['request', 'asyncoperation', 'plugintracelog']);
    expect(path.wallMs).toBe(9000);
    // The job ran 7 s after waiting 1.95 s in the queue; the plug-in ran 40 ms before it was queued.
    const job = path.segments.find((s) => s.spanId === 'asyncoperation:job')!;
    expect([job.selfMs, job.queueMs]).toEqual([7000, 1950]);
    expect(path.segments[0]!.spanId).toBe('asyncoperation:job');
    expect(path.segments.reduce((sum, s) => sum + s.selfMs + s.queueMs, 0)).toBe(9000);
  });

  it('is empty for an empty layout', () => {
    expect(criticalPath({ rows: [], start: 0, end: 0 })).toEqual({ spanIds: [], segments: [], wallMs: 0 });
  });
});
