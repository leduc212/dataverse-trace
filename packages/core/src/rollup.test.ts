import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { count, createHistogram } from './histogram.ts';
import {
  addSparse,
  aggregateRollups,
  buildRollups,
  coverage,
  heatmapFromRollups,
  hourOf,
  hoursOf,
  HOUR_MS,
  kpisFromRollups,
  stepStatsFromAggregates,
  timeSeriesFromRollups,
  toSparse,
  TRUNCATED_TEXT_CHARS,
  type StepHourRollup,
} from './rollup.ts';
import { computeKpis, computeStepStats, heatmapByDayHour, timeSeries } from './stats.ts';
import { T0, traceLog } from './test-builders.ts';

describe('buildRollups', () => {
  it('groups by step and UTC hour, with counts, errors, constructor time, depth and truncation', () => {
    const logs = [
      traceLog({ stepId: 's1', start: T0 + 1000, durationMs: 10, constructorMs: 4, depth: 2 }),
      traceLog({ stepId: 's1', start: T0 + 2000, durationMs: 30, constructorMs: null, exception: 'boom', messageBlockLength: TRUNCATED_TEXT_CHARS + 10 }),
      traceLog({ stepId: 's1', start: T0 + HOUR_MS, durationMs: 5, messageBlockLength: 100 }),
      traceLog({ stepId: 's2', start: T0 + 5, durationMs: 7 }),
    ];
    const rollups = buildRollups(logs);
    expect(rollups.map((r) => r.id)).toEqual([`s1@${T0}`, `s2@${T0}`, `s1@${T0 + HOUR_MS}`]);
    expect(rollups[0]).toMatchObject({ stepKey: 's1', hour: T0, count: 2, errors: 1, sumMs: 40, maxMs: 30, ctorCount: 1, ctorSumMs: 4, maxDepth: 2, textKnown: 1, truncated: 1 });
    expect(rollups[2]).toMatchObject({ count: 1, textKnown: 1, truncated: 0 });
    expect(hoursOf(logs)).toEqual([T0, T0 + HOUR_MS]);
  });

  it('keeps sparse histograms that round-trip', () => {
    const h = createHistogram();
    h[3] = 2;
    h[40] = 7;
    const sparse = toSparse(h);
    expect(sparse).toEqual([3, 2, 40, 7]);
    expect([...addSparse(createHistogram(), sparse)]).toEqual([...h]);
  });
});

describe('rollups agree with raw statistics', () => {
  const logArb = fc.record({
    stepId: fc.constantFrom('a', 'b', 'c'),
    offset: fc.integer({ min: 0, max: 48 * HOUR_MS }),
    durationMs: fc.integer({ min: 0, max: 60_000 }),
    error: fc.boolean(),
    depth: fc.integer({ min: 1, max: 8 }),
  });

  it('counts, errors, max and depth match exactly; percentiles are within one bucket', () => {
    fc.assert(
      fc.property(fc.array(logArb, { minLength: 1, maxLength: 200 }), (rows) => {
        // A step keeps one mode, as in real registrations.
        const logs = rows.map((r) => traceLog({ stepId: r.stepId, start: T0 + r.offset, durationMs: r.durationMs, exception: r.error ? 'x' : null, depth: r.depth, mode: r.stepId === 'a' ? 'sync' : 'async' }));
        const exact = computeStepStats(logs);
        const approx = stepStatsFromAggregates(aggregateRollups(buildRollups(logs)).values());
        expect(approx.map((s) => [s.key, s.count, s.errors, s.max])).toEqual(exact.map((s) => [s.key, s.count, s.errors, s.max]));
        for (const s of exact) {
          const a = approx.find((x) => x.key === s.key)!;
          // Same bucket as the exact value: within a factor of 1.25 either way.
          expect(a.p95).toBeGreaterThanOrEqual(s.p95 < 1 ? 0 : s.p95 / 1.25 - 1e-9);
          expect(a.p95).toBeLessThanOrEqual(Math.max(1, s.p95 * 1.25) + 1e-9);
          expect(a.avgMs).toBeCloseTo(s.avgMs, 6);
        }
        const k = computeKpis(logs);
        const rk = kpisFromRollups(buildRollups(logs), -Infinity, Infinity);
        expect([rk.executions, rk.errors, rk.maxDepth]).toEqual([k.executions, k.errors, k.maxDepth]);
      }),
      { numRuns: 60 },
    );
  });

  it('time series and heatmap totals match the raw versions', () => {
    const logs = Array.from({ length: 300 }, (_, i) => traceLog({ stepId: `s${i % 4}`, start: T0 + i * 11 * 60_000, exception: i % 7 === 0 ? 'x' : null }));
    const rollups = buildRollups(logs);
    const to = T0 + 300 * 11 * 60_000;
    const raw = timeSeries(logs, 6 * HOUR_MS, T0, to);
    const fromRollups = timeSeriesFromRollups(rollups, 6 * HOUR_MS, T0, to);
    expect(fromRollups).toEqual(raw);
    const hr = heatmapByDayHour(logs);
    const hm = heatmapFromRollups(rollups, T0, to);
    expect(hm.days).toEqual(hr.days);
    expect(hm.counts.flat().reduce((a, b) => a + b, 0)).toBe(300);
  });
});

describe('aggregateRollups', () => {
  it('only merges hours in [from, to)', () => {
    const logs = [traceLog({ stepId: 's', start: T0 }), traceLog({ stepId: 's', start: T0 + HOUR_MS }), traceLog({ stepId: 's', start: T0 + 2 * HOUR_MS })];
    const a = aggregateRollups(buildRollups(logs), T0 + HOUR_MS, T0 + 2 * HOUR_MS).get('s')!;
    expect(a.count).toBe(1);
    expect(count(a.hist)).toBe(1);
    expect([a.firstHour, a.lastHour]).toEqual([T0 + HOUR_MS, T0 + HOUR_MS]);
  });

  it('reports empty KPIs for an empty range', () => {
    expect(kpisFromRollups([], 0, 1)).toMatchObject({ executions: 0, errorRate: 0, p95SyncMs: null, slowestStep: null, from: null, to: null });
    expect(hourOf(T0 + 59 * 60_000)).toBe(T0);
  });
});

describe('coverage', () => {
  it('is the share of the range outside gaps', () => {
    expect(coverage([], 0, 100)).toBe(1);
    expect(coverage([[10, 30]], 0, 100)).toBeCloseTo(0.8);
    expect(coverage([[-50, 10], [90, 500]], 0, 100)).toBeCloseTo(0.8);
    expect(coverage([[0, 100]], 0, 100)).toBe(0);
    expect(coverage([[0, 5]], 10, 10)).toBe(1);
  });
});

describe('performance (NFR-P5: 90 days of rollups under 500 ms)', () => {
  it('aggregates 90 days × 30 steps × 24 hours', () => {
    const rollups: StepHourRollup[] = [];
    const hist = [10, 40, 12, 30, 14, 20, 20, 8, 30, 2];
    for (let h = 0; h < 90 * 24; h++) {
      for (let s = 0; s < 30; s++) {
        rollups.push({
          id: `s${s}@${h}`,
          stepKey: `s${s}`,
          hour: T0 + h * HOUR_MS,
          stepId: `s${s}`,
          typeName: `T${s}`,
          messageName: 'Update',
          primaryEntity: 'account',
          mode: s % 3 ? 'sync' : 'async',
          count: 100,
          errors: 1,
          sumMs: 5000,
          maxMs: 900,
          hist,
          ctorCount: 100,
          ctorSumMs: 200,
          ctorHist: [2, 100],
          maxDepth: 2,
          textKnown: 0,
          truncated: 0,
        });
      }
    }
    const from = T0;
    const to = T0 + 90 * 24 * HOUR_MS;
    const started = Date.now();
    const stats = stepStatsFromAggregates(aggregateRollups(rollups, from, to).values());
    kpisFromRollups(rollups, from, to, stats);
    timeSeriesFromRollups(rollups, 24 * HOUR_MS, from, to);
    heatmapFromRollups(rollups, from, to);
    expect(stats).toHaveLength(30);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
