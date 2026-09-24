import { buildRollups, HOUR_MS, type TraceLogRecord } from '@dvt/core';
import { describe, expect, it } from 'vitest';
import { Dataset } from './dataset.ts';
import { dashboard, type History } from './insights.ts';

const DAY = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
let n = 0;
const log = (start: number, p: Partial<TraceLogRecord> = {}): TraceLogRecord => ({
  id: `l${++n}`,
  correlationId: `c${n}`,
  requestId: 'r',
  stepId: 'step-a',
  typeName: 'Harbor.A',
  messageName: 'Update',
  primaryEntity: 'account',
  mode: 'sync',
  operationType: 'plugin',
  depth: 1,
  start,
  durationMs: 100,
  constructorMs: null,
  createdOn: start,
  createdById: null,
  createdByName: null,
  exception: null,
  messageBlockLength: null,
  precision: 's',
  ...p,
});

/** `perHour` executions every hour in [from, to). */
const steady = (from: number, to: number, perHour: number, p: Partial<TraceLogRecord> = {}) => {
  const out: TraceLogRecord[] = [];
  for (let h = from; h < to; h += HOUR_MS) for (let i = 0; i < perHour; i++) out.push(log(h + i * 1000, p));
  return out;
};

const noHistory: History = { rollups: [], rawFrom: -Infinity, oldestRollup: null };

describe('dashboard', () => {
  it('reads raw rows while they cover the range, and compares with the previous period', () => {
    const before = steady(NOW - 14 * DAY, NOW - 7 * DAY, 2, { durationMs: 100 });
    const after = steady(NOW - 7 * DAY, NOW, 3, { durationMs: 200 });
    const d = dashboard(new Dataset([...before, ...after], [], []), '7d', NOW, null, [], noHistory);
    expect(d.source).toBe('raw');
    expect(d.coverage).toBe(1);
    expect(d.kpis.executions).toBe(after.length);
    expect(d.change!.count).toBeCloseTo(0.5);
    expect(d.change!.p95).toBeCloseTo(1);
    expect(d.steps[0]!.change).toMatchObject({ errorRate: 0 });
    expect(d.steps[0]!.change!.count).toBeCloseTo(0.5);
  });

  it('counts time before local history as not collected, and skips a comparison with too little of it', () => {
    const logs = steady(NOW - 2 * DAY, NOW, 1);
    const d = dashboard(new Dataset(logs, [], []), '7d', NOW, null, [], noHistory);
    expect(d.coverage).toBeCloseTo(2 / 7, 2);
    expect(d.gaps).toEqual([[NOW - 7 * DAY, NOW - 2 * DAY]]);
    expect(d.change).toBeNull();
    expect(d.steps[0]!.change).toBeNull();
  });

  it('compares volumes per collected hour, so a gap is not a drop', () => {
    const before = steady(NOW - 14 * DAY, NOW - 7 * DAY, 2);
    // The same rate, but nothing collected for the first half of this week.
    const after = steady(NOW - 3.5 * DAY, NOW, 2);
    const d = dashboard(new Dataset([...before, ...after], [], []), '7d', NOW, null, [[NOW - 7 * DAY, NOW - 3.5 * DAY]], noHistory);
    expect(d.coverage).toBeCloseTo(0.5);
    expect(d.change!.count).toBeCloseTo(0, 5);
  });

  it('switches to rollups when the range reaches past the raw rows, and compares rollups with rollups', () => {
    const rawFrom = NOW - 30 * DAY;
    const old = steady(NOW - 180 * DAY, rawFrom, 1, { durationMs: 1000 });
    const recent = steady(rawFrom, NOW, 1, { durationMs: 1000, exception: 'x' });
    const history: History = { rollups: buildRollups([...old, ...recent]), rawFrom, oldestRollup: NOW - 180 * DAY };
    const d = dashboard(new Dataset(recent, [], []), '90d', NOW, null, [], history);
    expect(d.source).toBe('rollups');
    expect(d.kpis.executions).toBe(90 * 24);
    expect(d.kpis.errors).toBe(30 * 24);
    expect(d.bucketMs).toBe(DAY);
    expect(d.series).toHaveLength(91);
    expect(d.change!.p95).toBeCloseTo(0);
    expect(d.change!.errorRate).toBeCloseTo(1 / 3);
    // The same p95 in both periods: an estimate, but the same estimate on both sides.
    expect(d.kpis.p95SyncMs).toBeGreaterThan(1000 / 1.25);
    expect(d.kpis.p95SyncMs).toBeLessThanOrEqual(1000);
  });

  it('"All history" starts at the oldest rollup and has nothing to compare with', () => {
    const rawFrom = NOW - 30 * DAY;
    const old = steady(NOW - 40 * DAY, rawFrom, 1);
    const recent = steady(rawFrom, NOW, 1);
    const history: History = { rollups: buildRollups([...old, ...recent]), rawFrom, oldestRollup: NOW - 40 * DAY };
    const d = dashboard(new Dataset(recent, [], []), 'all', NOW, null, [], history);
    expect(d.from).toBe(NOW - 40 * DAY);
    expect(d.oldest).toBe(NOW - 40 * DAY);
    expect(d.source).toBe('rollups');
    expect(d.kpis.executions).toBe(40 * 24);
    expect(d.change).toBeNull();
    expect(d.coverage).toBe(1);
  });
});
