import { mapTraceLog } from '@dvt/dataverse';
import { aggregateRollups, buildRollups, HOUR_MS } from '@dvt/core';
import { describe, expect, it } from 'vitest';
import { generateDemo } from './generator.ts';
import { demoHistory } from './history.ts';

const NOW = Date.UTC(2026, 8, 24, 15, 0, 0);
const DAY = 24 * HOUR_MS;
const demo = generateDemo({ now: NOW });
const recent = buildRollups(demo.traceLogs.map(mapTraceLog));
const history = demoHistory(recent, { now: NOW, rawFrom: demo.from });

describe('demoHistory', () => {
  it('fills the 90 days before the raw rows, leaving a three-day gap', () => {
    const hours = history.rollups.map((r) => r.hour);
    expect(Math.min(...hours)).toBeGreaterThanOrEqual(NOW - 90 * DAY - HOUR_MS);
    expect(Math.max(...hours)).toBeLessThan(demo.from);
    const [gap] = history.gaps;
    expect(gap![1] - gap![0]).toBe(3 * DAY);
    expect(hours.some((h) => h >= gap![0] && h < gap![1])).toBe(false);
    expect(history.rawFrom).toBe(demo.from);
  });

  it('keeps each rollup consistent and volume a little lower than the recent weeks', () => {
    for (const r of history.rollups) {
      const histTotal = r.hist.reduce((sum, v, i) => (i % 2 ? sum + v : sum), 0);
      expect(histTotal).toBe(r.count);
      expect(r.errors).toBeLessThanOrEqual(r.count);
      expect(r.id).toBe(`${r.stepKey}@${r.hour}`);
    }
    const perDay = (from: number, to: number) => [...aggregateRollups(history.rollups.concat(recent), from, to).values()].reduce((s, a) => s + a.count, 0) / ((to - from) / DAY);
    const old = perDay(NOW - 84 * DAY, NOW - 56 * DAY);
    const reference = perDay(demo.from, demo.from + 7 * DAY);
    expect(old).toBeGreaterThan(reference * 0.6);
    expect(old).toBeLessThan(reference);
  });

  it('is deterministic', () => {
    expect(demoHistory(recent, { now: NOW, rawFrom: demo.from }).rollups.slice(0, 50)).toEqual(history.rollups.slice(0, 50));
  });
});
