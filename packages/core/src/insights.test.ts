import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, insights, resolveThresholds, type Insight, type InsightInput, type InsightStep } from './insights.ts';
import type { TraceLogRecord } from './records.ts';
import { buildRollups, HOUR_MS } from './rollup.ts';
import { computeStepStats } from './stats.ts';
import { asyncOp, flowRun, T0, traceLog } from './test-builders.ts';

const DAY = 24 * HOUR_MS;
const NOW = T0 + 10 * DAY;

/** Runs the rules over `logs` (all in raw and in rollups), for the last 7 days by default. */
function run(logs: TraceLogRecord[], p: Partial<InsightInput> & { filtering?: Record<string, string[] | null> } = {}): Insight[] {
  const from = p.from ?? NOW - 7 * DAY;
  const inRange = logs.filter((l) => l.start >= from && l.start <= NOW);
  const steps: InsightStep[] = computeStepStats(inRange).map((s) => ({ ...s, filteringAttributes: s.stepId && p.filtering ? p.filtering[s.stepId] : undefined }));
  const { filtering: _f, ...rest } = p;
  return insights({
    now: NOW,
    from,
    to: NOW,
    steps,
    logs: inRange,
    rollups: buildRollups(logs),
    jobs: [],
    flowRuns: [],
    flowEvents: [],
    settings: null,
    canReadTraceText: true,
    gaps: [],
    ...rest,
  });
}

const rules = (list: Insight[]) => list.map((i) => i.rule);
const many = (n: number, p: (i: number) => Partial<TraceLogRecord>) => Array.from({ length: n }, (_, i) => traceLog(p(i)));

describe('insights', () => {
  it('finds nothing in healthy data', () => {
    expect(run(many(50, (i) => ({ stepId: 's', start: NOW - i * HOUR_MS, durationMs: 40, constructorMs: 1 })), { filtering: { s: ['name'] } })).toEqual([]);
  });

  it('flags deep operations as a possible loop, from raw rows or else from rollups', () => {
    const logs = [traceLog({ correlationId: 'loop', depth: 7, start: NOW - HOUR_MS }), traceLog({ correlationId: 'loop', depth: 8, start: NOW - HOUR_MS })];
    const [deep] = run(logs);
    expect(deep).toMatchObject({ rule: 'loopDepth', severity: 'critical', title: 'Depth 8 reached in 1 operation', query: 'depth>=6' });
    // Only the rollups know about it (the raw rows are gone).
    const older = run(logs, { logs: [] });
    expect(older[0]).toMatchObject({ rule: 'loopDepth', title: 'Depth 8 reached' });
    expect(older[0]!.query).toBeUndefined();
    expect(run(logs, { thresholds: { loopDepth: 9 } }).filter((i) => i.rule === 'loopDepth')).toEqual([]);
  });

  it('flags a step that runs at three or more depths of one operation, but not at two', () => {
    const chain = (corr: string, depths: number[]) => depths.map((depth) => traceLog({ stepId: 'rollup', typeName: 'Harbor.AccountRollup', correlationId: corr, depth, start: NOW - HOUR_MS }));
    expect(rules(run([...chain('a', [1, 2])]))).not.toContain('reentry');
    const found = run([...chain('a', [1, 2, 3]), ...chain('b', [1, 2, 3, 4]), ...chain('c', [1])]).find((i) => i.rule === 'reentry')!;
    expect(found.title).toBe('Harbor.AccountRollup runs again inside its own operations');
    expect(found.evidence).toEqual(['2 operations where it ran at 3 or more depths', 'Depths 1, 2, 3, 4 in operation b']);
    expect(found.query).toBe('corr:b');
  });

  it('reports steps that re-enter in the same operations as one loop', () => {
    const at = (typeName: string, messageName: string, primaryEntity: string, corr: string, depths: number[]) =>
      depths.map((depth) => traceLog({ stepId: typeName, typeName, messageName, primaryEntity, correlationId: corr, depth, start: NOW - HOUR_MS }));
    const logs = [...at('Harbor.ContactSync', 'Update', 'contact', 'x', [1, 3, 5]), ...at('Harbor.AccountCount', 'Update', 'account', 'x', [2, 4, 6]), ...at('Harbor.AccountCount', 'Update', 'account', 'y', [2, 4, 6])];
    const found = run(logs).filter((i) => i.rule === 'reentry');
    expect(found.map((i) => i.title)).toEqual(['Harbor.AccountCount and Harbor.ContactSync trigger each other', 'Harbor.AccountCount runs again inside its own operations']);
    expect(found[0]!.evidence).toEqual([
      '1 operation where each ran at 3 or more depths',
      'Harbor.AccountCount: Update of account',
      'Harbor.ContactSync: Update of contact',
      'Depths 1, 2, 3, 4, 5, 6 in operation x',
    ]);
  });

  it('flags busy Update steps without filtering attributes', () => {
    const logs = many(800, (i) => ({ stepId: 's', start: NOW - (i % 160) * HOUR_MS, durationMs: 5 }));
    expect(rules(run(logs, { filtering: { s: null } }))).toEqual(['noFilter']);
    expect(rules(run(logs, { filtering: { s: ['name'] } }))).toEqual([]);
    // Unknown registration: can't tell, so no finding.
    expect(rules(run(logs))).toEqual([]);
    expect(rules(run(logs, { filtering: { s: null }, thresholds: { noFilterRunsPerDay: 1000 } }))).toEqual([]);
  });

  it('flags slow sync steps but not slow async ones', () => {
    const slow = (mode: 'sync' | 'async') => many(20, (i) => ({ stepId: mode, mode, start: NOW - i * HOUR_MS, durationMs: 3000 }));
    const found = run([...slow('sync'), ...slow('async')]);
    expect(found.map((i) => [i.rule, i.id])).toEqual([['slowSync', 'slow:sync']]);
    expect(found[0]!.query).toBe('step:sync dur>2000');
  });

  it('flags heavy constructors by p95 or by share of execution time, ignoring tiny steps', () => {
    const byP95 = many(20, (i) => ({ stepId: 'a', start: NOW - i * HOUR_MS, durationMs: 2000, constructorMs: 150 }));
    const byShare = many(20, (i) => ({ stepId: 'b', start: NOW - i * HOUR_MS, durationMs: 60, constructorMs: 30 }));
    const tiny = many(20, (i) => ({ stepId: 'c', start: NOW - i * HOUR_MS, durationMs: 4, constructorMs: 3 }));
    const found = run([...byP95, ...byShare, ...tiny]).filter((i) => i.rule === 'heavyConstructor');
    expect(found.map((i) => i.id).sort()).toEqual(['ctor:a', 'ctor:b']);
    expect(found.find((i) => i.id === 'ctor:b')!.evidence[1]).toBe('That is 50 % of the average execution (60 ms)');
  });

  it('flags failing steps, and reports an error spike instead when the last 24 h are much worse than the week before', () => {
    const steady = many(100, (i) => ({ stepId: 'f', start: NOW - i * HOUR_MS, exception: i % 10 === 0 ? 'boom' : null }));
    expect(run(steady).map((i) => [i.rule, i.severity, i.title])).toEqual([['failing', 'warning', 'Harbor.Plugins.Sample fails 10 % of the time']]);

    const baseline = many(200, (i) => ({ stepId: 'n', start: NOW - DAY - (i + 1) * 0.8 * HOUR_MS, exception: i % 100 === 0 ? 'x' : null }));
    const today = many(40, (i) => ({ stepId: 'n', start: NOW - i * 0.5 * HOUR_MS, exception: i % 3 === 0 ? 'relay down' : null }));
    const spike = run([...baseline, ...today]);
    expect(rules(spike)).toEqual(['errorSpike']);
    expect(spike[0]).toMatchObject({ severity: 'critical', queryRange: '24h', query: 'step:n err' });
    expect(spike[0]!.title).toMatch(/fails \d+(\.\d)?× as often as usual/);
    expect(spike[0]!.evidence).toEqual(['Last 24 h: 14 of 40 runs failed (35 %)', '7 days before: 2 of 200 runs (1.0 %)']);

    // A step that never failed before "started failing".
    const clean = many(200, (i) => ({ stepId: 'm', start: NOW - DAY - (i + 1) * 0.8 * HOUR_MS }));
    const broken = many(30, (i) => ({ stepId: 'm', start: NOW - i * 0.5 * HOUR_MS, exception: i % 2 ? 'x' : null }));
    expect(run([...clean, ...broken])[0]!.title).toBe('Harbor.Plugins.Sample started failing');
    // Too little history for a baseline: plain "failing".
    expect(rules(run(broken))).toEqual(['failing']);
  });

  it('flags steps whose trace text is cut at 10 KB', () => {
    const logs = many(30, (i) => ({ stepId: 't', start: NOW - i * HOUR_MS, messageBlockLength: i % 3 === 0 ? 10_240 : 400 }));
    const [found] = run(logs);
    expect(found).toMatchObject({ rule: 'truncatedText', evidence: ['10 of 30 traces with text are at the 10 KB limit (33 %)'] });
    expect(run(logs.slice(0, 10))).toEqual([]);
  });

  it('flags retry storms and waiting queues per step', () => {
    const jobs = [
      ...Array.from({ length: 3 }, () => asyncOp({ stepId: 'erp', name: 'Harbor.ClaimErpExport: Create of hbr_claim', createdOn: NOW - DAY, retryCount: 3, statusCode: 31 })),
      ...Array.from({ length: 60 }, () => asyncOp({ stepId: 'mail', name: 'Harbor.Mail: Update of account', createdOn: NOW - HOUR_MS, statusCode: 10 })),
      asyncOp({ stepId: 'ok', createdOn: NOW - HOUR_MS, retryCount: 1 }),
      asyncOp({ stepId: 'old', createdOn: NOW - 30 * DAY, retryCount: 5 }),
    ];
    const found = run([], { jobs }).filter((i) => i.rule === 'retryStorm');
    expect(found.map((i) => [i.title, i.severity])).toEqual([
      ['Harbor.ClaimErpExport keeps retrying', 'warning'],
      ['60 jobs of Harbor.Mail are waiting', 'warning'],
    ]);
    expect(found[0]!.evidence).toEqual(['3 jobs needed retries (9 retries in total)', '3 jobs still failed after retrying']);
  });

  it('reports failing flows and flow ingestion problems in the range', () => {
    const runs = Array.from({ length: 20 }, (_, i) => flowRun({ start: NOW - i * HOUR_MS, status: i < 6 ? 'failed' : 'succeeded' }));
    const events = [{ id: 'e', eventType: 'FlowRunIngestion', eventCode: 'Delayed', level: 'Warning', name: 'Runs may be missing', createdOn: NOW - DAY, parentObjectId: null }];
    const found = run([], { flowRuns: runs, flowEvents: events });
    expect(found.map((i) => [i.rule, i.severity])).toEqual([
      ['flowFailing', 'critical'],
      ['flowDataIncomplete', 'info'],
    ]);
  });

  it('reports environment limits and long collection gaps', () => {
    const found = run([], {
      settings: { pluginTraceLogSetting: 0, isAuditEnabled: true, maxUploadFileSize: null },
      canReadTraceText: false,
      gaps: [
        [NOW - 3 * DAY, NOW - 1 * DAY],
        [NOW - 5 * DAY, NOW - 5 * DAY + HOUR_MS],
      ],
    });
    expect(rules(found)).toEqual(['tracingOff', 'textHidden', 'syncGap']);
    expect(found[2]!.title).toBe('No data was collected for 48h 00m');
    expect(run([], { settings: { pluginTraceLogSetting: 1, isAuditEnabled: null, maxUploadFileSize: null } })[0]!.rule).toBe('tracingExceptions');
  });

  it('sorts by severity and keeps rule order within a severity', () => {
    const found = run(
      [traceLog({ correlationId: 'loop', depth: 8, start: NOW - HOUR_MS }), ...many(20, (i) => ({ stepId: 'slow', start: NOW - i * HOUR_MS, durationMs: 5000 }))],
      { canReadTraceText: false },
    );
    expect(found.map((i) => i.severity)).toEqual(['critical', 'warning', 'info']);
  });
});

describe('resolveThresholds', () => {
  it('keeps valid numbers and falls back to defaults for the rest', () => {
    expect(resolveThresholds(null)).toEqual(DEFAULT_THRESHOLDS);
    const t = resolveThresholds({ loopDepth: 4, slowSyncP95Ms: -1, spikeFactor: Number.NaN, failingRate: '0.5' as never, unknown: 3 } as never);
    expect(t).toEqual({ ...DEFAULT_THRESHOLDS, loopDepth: 4 });
  });
});
