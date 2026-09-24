// Hourly per-step rollups: the long-lived summary of trace log history. Raw rows are deleted after
// 30 days (and the platform deletes them after about one), but rollups are kept for 400 days, so
// trends, baselines and the dashboard's long ranges read these instead of raw rows.
import { BUCKETS, bucketOf, createHistogram, histogramQuantileInterpolated, type Histogram } from './histogram.ts';
import type { ExecutionMode, TraceLogRecord } from './records.ts';
import { localDayKey, stepKeyOf, type Heatmap, type Kpis, type StepStats, type TimeBucket } from './stats.ts';

export const HOUR_MS = 3_600_000;

/** Trace text longer than this is treated as cut off at the platform's 10 KB limit. */
export const TRUNCATED_TEXT_CHARS = 9_800;

/** Start of the UTC hour that contains `ts`. */
export const hourOf = (ts: number): number => Math.floor(ts / HOUR_MS) * HOUR_MS;

/**
 * Sparse histogram: flat `[bucket, count, bucket, count, …]` pairs, ascending by bucket. Most steps
 * fall in a handful of buckets per hour, so this is far smaller than 64 counters.
 */
export type SparseHistogram = number[];

export function toSparse(h: Histogram): SparseHistogram {
  const out: number[] = [];
  for (let i = 0; i < BUCKETS; i++) if (h[i]) out.push(i, h[i]!);
  return out;
}

/** Adds a sparse histogram into a dense one. */
export function addSparse(into: Histogram, sparse: SparseHistogram): Histogram {
  for (let i = 0; i + 1 < sparse.length; i += 2) into[sparse[i]!]! += sparse[i + 1]!;
  return into;
}

/** One step's executions in one UTC hour. */
export interface StepHourRollup {
  /** `${stepKey}@${hour}`. */
  id: string;
  stepKey: string;
  /** Start of the UTC hour (epoch ms). */
  hour: number;
  stepId: string | null;
  typeName: string;
  messageName: string;
  primaryEntity: string | null;
  mode: ExecutionMode;
  count: number;
  errors: number;
  sumMs: number;
  maxMs: number;
  hist: SparseHistogram;
  /** Executions that reported a constructor time, and their totals. */
  ctorCount: number;
  ctorSumMs: number;
  ctorHist: SparseHistogram;
  maxDepth: number;
  /** Executions whose trace text is known (fetched and readable). */
  textKnown: number;
  /** Of those, how many are at the 10 KB limit. */
  truncated: number;
}

/** Builds the rollups of every (step, hour) pair present in `logs`. */
export function buildRollups(logs: Iterable<TraceLogRecord>): StepHourRollup[] {
  const groups = new Map<string, { r: StepHourRollup; hist: Histogram; ctor: Histogram }>();
  for (const log of logs) {
    const stepKey = stepKeyOf(log);
    const hour = hourOf(log.start);
    const id = `${stepKey}@${hour}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        r: {
          id,
          stepKey,
          hour,
          stepId: log.stepId,
          typeName: log.typeName,
          messageName: log.messageName,
          primaryEntity: log.primaryEntity,
          mode: log.mode,
          count: 0,
          errors: 0,
          sumMs: 0,
          maxMs: 0,
          hist: [],
          ctorCount: 0,
          ctorSumMs: 0,
          ctorHist: [],
          maxDepth: 0,
          textKnown: 0,
          truncated: 0,
        },
        hist: createHistogram(),
        ctor: createHistogram(),
      };
      groups.set(id, g);
    }
    const r = g.r;
    r.count++;
    if (log.exception) r.errors++;
    r.sumMs += log.durationMs;
    r.maxMs = Math.max(r.maxMs, log.durationMs);
    g.hist[bucketOf(log.durationMs)]!++;
    if (log.constructorMs !== null) {
      r.ctorCount++;
      r.ctorSumMs += log.constructorMs;
      g.ctor[bucketOf(log.constructorMs)]!++;
    }
    r.maxDepth = Math.max(r.maxDepth, log.depth);
    if (log.messageBlockLength !== null) {
      r.textKnown++;
      if (log.messageBlockLength >= TRUNCATED_TEXT_CHARS) r.truncated++;
    }
  }
  const out: StepHourRollup[] = [];
  for (const { r, hist, ctor } of groups.values()) {
    r.hist = toSparse(hist);
    r.ctorHist = toSparse(ctor);
    out.push(r);
  }
  return out.sort((a, b) => a.hour - b.hour || (a.stepKey < b.stepKey ? -1 : 1));
}

/** Hours (UTC hour starts) touched by `logs`, ascending. */
export const hoursOf = (logs: Iterable<TraceLogRecord>): number[] => [...new Set([...logs].map((l) => hourOf(l.start)))].sort((a, b) => a - b);

/** A step's totals over a range, merged from its hourly rollups. */
export interface StepAggregate extends Omit<StepHourRollup, 'id' | 'hour' | 'hist' | 'ctorHist'> {
  hist: Histogram;
  ctorHist: Histogram;
  firstHour: number;
  lastHour: number;
}

/** Merges rollups whose hour is in [from, to) per step. */
export function aggregateRollups(rollups: Iterable<StepHourRollup>, from = -Infinity, to = Infinity): Map<string, StepAggregate> {
  const out = new Map<string, StepAggregate>();
  for (const r of rollups) {
    if (r.hour < from || r.hour >= to) continue;
    let a = out.get(r.stepKey);
    if (!a) {
      const { id: _id, hour, hist: _h, ctorHist: _c, ...rest } = r;
      a = { ...rest, count: 0, errors: 0, sumMs: 0, maxMs: 0, ctorCount: 0, ctorSumMs: 0, maxDepth: 0, textKnown: 0, truncated: 0, hist: createHistogram(), ctorHist: createHistogram(), firstHour: hour, lastHour: hour };
      out.set(r.stepKey, a);
    }
    a.count += r.count;
    a.errors += r.errors;
    a.sumMs += r.sumMs;
    a.maxMs = Math.max(a.maxMs, r.maxMs);
    a.ctorCount += r.ctorCount;
    a.ctorSumMs += r.ctorSumMs;
    a.maxDepth = Math.max(a.maxDepth, r.maxDepth);
    a.textKnown += r.textKnown;
    a.truncated += r.truncated;
    addSparse(a.hist, r.hist);
    addSparse(a.ctorHist, r.ctorHist);
    a.firstHour = Math.min(a.firstHour, r.hour);
    a.lastHour = Math.max(a.lastHour, r.hour);
  }
  return out;
}

/** Step statistics from aggregated rollups. Percentiles are estimates within the bucket that holds them (within 25 %). */
export function stepStatsFromAggregates(aggregates: Iterable<StepAggregate>): StepStats[] {
  const out: StepStats[] = [];
  for (const a of aggregates) {
    if (a.count === 0) continue;
    out.push({
      key: a.stepKey,
      stepId: a.stepId,
      typeName: a.typeName,
      messageName: a.messageName,
      primaryEntity: a.primaryEntity,
      mode: a.mode,
      count: a.count,
      errors: a.errors,
      errorRate: a.errors / a.count,
      // Never report a percentile above the largest value actually seen.
      p50: Math.min(histogramQuantileInterpolated(a.hist, 0.5)!, a.maxMs),
      p95: Math.min(histogramQuantileInterpolated(a.hist, 0.95)!, a.maxMs),
      max: a.maxMs,
      avgMs: a.sumMs / a.count,
      avgConstructorMs: a.ctorCount ? a.ctorSumMs / a.ctorCount : null,
      firstSeen: a.firstHour,
      lastSeen: a.lastHour + HOUR_MS - 1,
    });
  }
  return out.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

/** Dashboard KPIs from rollups in [from, to). */
export function kpisFromRollups(rollups: readonly StepHourRollup[], from: number, to: number, stats?: readonly StepStats[]): Kpis {
  const aggregates = aggregateRollups(rollups, from, to);
  const steps = stats ?? stepStatsFromAggregates(aggregates.values());
  const sync = createHistogram();
  let executions = 0;
  let errors = 0;
  let maxDepth = 0;
  let syncMax = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const a of aggregates.values()) {
    executions += a.count;
    errors += a.errors;
    maxDepth = Math.max(maxDepth, a.maxDepth);
    first = first === null ? a.firstHour : Math.min(first, a.firstHour);
    last = last === null ? a.lastHour : Math.max(last, a.lastHour);
    if (a.mode === 'sync') {
      for (let i = 0; i < BUCKETS; i++) sync[i]! += a.hist[i]!;
      syncMax = Math.max(syncMax, a.maxMs);
    }
  }
  const p95 = histogramQuantileInterpolated(sync, 0.95);
  const slowest = steps.filter((s) => s.count >= 3).sort((a, b) => b.p95 - a.p95)[0];
  return {
    executions,
    errors,
    errorRate: executions ? errors / executions : 0,
    p95SyncMs: p95 === null ? null : Math.min(p95, syncMax),
    maxDepth,
    slowestStep: slowest ? { name: slowest.typeName, p95: slowest.p95 } : null,
    from: first,
    to: last === null ? null : last + HOUR_MS - 1,
  };
}

/** Executions and errors per bucket, like {@link timeSeries}, from rollups. `bucketMs` should be a multiple of an hour. */
export function timeSeriesFromRollups(rollups: readonly StepHourRollup[], bucketMs: number, from: number, to: number): TimeBucket[] {
  const first = Math.floor(from / bucketMs) * bucketMs;
  const n = Math.max(1, Math.floor((to - first) / bucketMs) + 1);
  const buckets: TimeBucket[] = Array.from({ length: n }, (_, i) => ({ start: first + i * bucketMs, count: 0, errors: 0 }));
  for (const r of rollups) {
    if (r.hour < hourOf(from) || r.hour > to) continue;
    const b = buckets[Math.floor((r.hour - first) / bucketMs)];
    if (!b) continue;
    b.count += r.count;
    b.errors += r.errors;
  }
  return buckets;
}

/** Executions per local day × hour of day, from rollups (hours are placed by their local start time). */
export function heatmapFromRollups(rollups: readonly StepHourRollup[], from: number, to: number): Heatmap {
  const index = new Map<string, { counts: number[]; errors: number[] }>();
  for (const r of rollups) {
    if (r.hour < hourOf(from) || r.hour > to) continue;
    const day = localDayKey(r.hour);
    let row = index.get(day);
    if (!row) {
      row = { counts: new Array<number>(24).fill(0), errors: new Array<number>(24).fill(0) };
      index.set(day, row);
    }
    const h = new Date(r.hour).getHours();
    row.counts[h]! += r.count;
    row.errors[h]! += r.errors;
  }
  const days = [...index.keys()].sort();
  const counts = days.map((d) => index.get(d)!.counts);
  return { days, counts, errors: days.map((d) => index.get(d)!.errors), max: Math.max(0, ...counts.flat()) };
}

/**
 * Share of [from, to] not covered by a gap (0–1). Gaps are periods when no data was collected, so
 * a low value means the numbers in the range undercount what really ran.
 */
export function coverage(gaps: ReadonlyArray<readonly [number, number]>, from: number, to: number): number {
  if (to <= from) return 1;
  let missing = 0;
  for (const [a, b] of gaps) missing += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return Math.max(0, 1 - missing / (to - from));
}
