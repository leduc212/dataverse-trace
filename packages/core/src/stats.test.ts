import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDuration, formatPercent } from './format.ts';
import { bucketOf, createHistogram, histogramQuantile, merge, quantileSorted, record } from './histogram.ts';
import { computeKpis, computeStepStats, heatmapByDayHour, timeSeries } from './stats.ts';
import { T0, traceLog } from './test-builders.ts';

describe('computeStepStats', () => {
  it('groups by step id and computes percentiles, errors and constructor time', () => {
    const logs = [10, 20, 30, 40, 1000].map((d, i) => traceLog({ stepId: 's1', durationMs: d, constructorMs: 2, exception: i === 4 ? 'boom' : null }));
    logs.push(traceLog({ stepId: 's2', durationMs: 5 }));
    const [s1, s2] = computeStepStats(logs);
    expect(s1).toMatchObject({ key: 's1', count: 5, errors: 1, errorRate: 0.2, p50: 30, p95: 1000, max: 1000, avgConstructorMs: 2 });
    expect(s2).toMatchObject({ key: 's2', count: 1 });
  });

  it('falls back to type + message + table + mode when the step id is unknown', () => {
    const [s] = computeStepStats([traceLog({ stepId: null, typeName: 'T', messageName: 'Create', primaryEntity: 'lead', mode: 'async' })]);
    expect(s!.key).toBe('T|Create|lead|async');
  });
});

describe('computeKpis', () => {
  it('summarises executions, errors, sync p95 and max depth', () => {
    const logs = [
      traceLog({ mode: 'sync', durationMs: 100, depth: 1 }),
      traceLog({ mode: 'sync', durationMs: 900, depth: 3, exception: 'x' }),
      traceLog({ mode: 'async', durationMs: 50_000, depth: 1 }),
    ];
    expect(computeKpis(logs)).toMatchObject({ executions: 3, errors: 1, p95SyncMs: 900, maxDepth: 3 });
    expect(computeKpis([])).toMatchObject({ executions: 0, errorRate: 0, p95SyncMs: null, slowestStep: null });
  });
});

describe('timeSeries and heatmap', () => {
  it('buckets executions contiguously', () => {
    const hour = 3_600_000;
    const logs = [traceLog({ start: T0 }), traceLog({ start: T0 + 10 }), traceLog({ start: T0 + 2 * hour, exception: 'x' })];
    const series = timeSeries(logs, hour, T0, T0 + 2 * hour);
    expect(series.map((b) => [b.count, b.errors])).toEqual([
      [2, 0],
      [0, 0],
      [1, 1],
    ]);
  });

  it('counts per local day and hour', () => {
    const h = heatmapByDayHour([traceLog({ start: T0 }), traceLog({ start: T0 }), traceLog({ start: T0 + 86_400_000 })]);
    expect(h.days).toHaveLength(2);
    expect(h.max).toBe(2);
    expect(h.counts.flat().reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('histogram', () => {
  it('buckets are monotonic', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), fc.double({ min: 0, max: 1e7, noNaN: true }), (a, b) => {
      if (a <= b) expect(bucketOf(a)).toBeLessThanOrEqual(bucketOf(b));
    }));
  });

  it('approximate quantiles stay within one bucket (25 %) of the exact value', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 600_000 }), { minLength: 1, maxLength: 300 }), fc.constantFrom(0.5, 0.95, 0.99), (values, q) => {
        const h = createHistogram();
        values.forEach((v) => record(h, v));
        const exact = quantileSorted([...values].sort((a, b) => a - b), q)!;
        const approx = histogramQuantile(h, q)!;
        expect(approx).toBeGreaterThanOrEqual(exact);
        expect(approx).toBeLessThanOrEqual(exact * 1.25 + 1e-9);
      }),
    );
  });

  it('merging equals recording everything into one histogram', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(100_000)), fc.array(fc.nat(100_000)), (xs, ys) => {
        const a = createHistogram();
        const b = createHistogram();
        const all = createHistogram();
        xs.forEach((v) => (record(a, v), record(all, v)));
        ys.forEach((v) => (record(b, v), record(all, v)));
        expect([...merge(a, b)]).toEqual([...all]);
      }),
    );
  });
});

describe('format', () => {
  it.each([
    [0, '0 ms'],
    [850, '850 ms'],
    [1234, '1.23 s'],
    [12_345, '12.3 s'],
    [61_000, '1m 01s'],
    [3_723_000, '1h 02m'],
    [null, '–'],
  ])('formatDuration(%s) = %s', (ms, text) => expect(formatDuration(ms)).toBe(text));

  it('formats percentages', () => {
    expect([formatPercent(0), formatPercent(0.0004), formatPercent(0.0183), formatPercent(0.42)]).toEqual(['0 %', '<0.1 %', '1.8 %', '42 %']);
  });
});
