// Dashboard data: statistics from raw rows or rollups, changes against the previous period, and the insight rules.
import {
  aggregateRollups,
  computeKpis,
  computeStepStats,
  coverage,
  heatmapByDayHour,
  heatmapFromRollups,
  hourOf,
  insights,
  kpisFromRollups,
  stepStatsFromAggregates,
  summarizePlatformStats,
  stepKeyOf,
  timeSeries,
  timeSeriesFromRollups,
  type Heatmap,
  type InsightThresholds,
  type PluginTypeStatSnapshot,
  type Kpis,
  type StepHourRollup,
  type StepStats,
  type TimeBucket,
  type TraceLogRecord,
} from '@dvt/core';
import { addGap, type Capabilities } from '@dvt/dataverse';
import { DASHBOARD_RANGE_MS, type DashboardData, type DashboardRangeKey, type DashboardStep, type PeriodChange } from '../shared/api.ts';
import type { Dataset } from './dataset.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SPARK_BUCKETS = 14;

function bucketFor(range: DashboardRangeKey, spanMs: number): number {
  if (range === '1h') return 5 * 60_000;
  if (range === '24h') return HOUR;
  if (range === '7d') return 6 * HOUR;
  if (range === '90d') return DAY;
  return spanMs > 120 * DAY ? 7 * DAY : DAY;
}

/** Long-lived history the dashboard reads besides the raw rows in {@link Dataset}. */
export interface History {
  /** Rollups from the start of the previous period, or 8 days ago if that's earlier (error-spike baselines). */
  rollups: StepHourRollup[];
  /** Raw rows are complete from this time on (older ones were pruned). */
  rawFrom: number;
  oldestRollup: number | null;
  /** Every stored snapshot of the platform's plug-in type statistics. */
  pluginStats?: PluginTypeStatSnapshot[];
}

interface Period {
  stats: StepStats[];
  kpis: Kpis;
}

function rawPeriod(logs: readonly TraceLogRecord[]): Period {
  const stats = computeStepStats(logs);
  return { stats, kpis: computeKpis(logs, stats) };
}

function rollupPeriod(rollups: readonly StepHourRollup[], from: number, to: number): Period {
  const stats = stepStatsFromAggregates(aggregateRollups(rollups, from, to).values());
  return { stats, kpis: kpisFromRollups(rollups, from, to, stats) };
}

interface Comparable {
  count: number;
  errorRate: number;
  p95: number | null;
}

/** Volumes are compared per hour of collected data, so a gap in either period doesn't read as a change. */
function change(after: Comparable, afterCoverage: number, before: Comparable, beforeCoverage: number): PeriodChange {
  return {
    count: before.count > 0 ? after.count / afterCoverage / (before.count / beforeCoverage) - 1 : null,
    errorRate: before.count > 0 ? after.errorRate - before.errorRate : null,
    p95: after.p95 !== null && before.p95 !== null && before.p95 > 0 ? after.p95 / before.p95 - 1 : null,
  };
}

const kpiComparable = (k: Kpis): Comparable => ({ count: k.executions, errorRate: k.errorRate, p95: k.p95SyncMs });

/** Minimum share of the previous period with data collected before it's worth comparing with. */
const MIN_COMPARE_COVERAGE = 0.5;

export function dashboard(
  data: Dataset,
  range: DashboardRangeKey,
  now: number,
  caps: Capabilities | null,
  collectedGaps: Array<[number, number]>,
  history: History,
  thresholds?: Partial<InsightThresholds>,
): DashboardData {
  const span = DASHBOARD_RANGE_MS[range];
  const oldestRaw = data.logs.length ? data.logs[data.logs.length - 1]!.start : null;
  const known = [oldestRaw, history.oldestRollup].filter((t): t is number => t !== null);
  const oldest = known.length ? Math.min(...known) : null;
  const from = span !== null ? now - span : (oldest ?? now - DAY);
  const source: DashboardData['source'] = from >= history.rawFrom ? 'raw' : 'rollups';
  const bucketMs = source === 'rollups' ? Math.max(bucketFor(range, now - from), HOUR) : bucketFor(range, now - from);

  // Time before local history starts counts as "not collected", like any other gap.
  const horizon = span !== null ? from - span : from;
  const gaps = addGap(collectedGaps, [horizon, oldest ?? now]);
  const clip = (lo: number, hi: number): Array<[number, number]> => gaps.filter(([x, y]) => y > lo && x < hi).map(([x, y]): [number, number] => [Math.max(x, lo), Math.min(y, hi)]);
  const rangeGaps = clip(from, now);
  const currentCoverage = coverage(rangeGaps, from, now);

  const inRange = data.logsBetween(from, now);
  let current: Period;
  let series: TimeBucket[];
  let heatmap: Heatmap;
  const sparks = new Map<string, number[]>();
  const sparkMs = (now - from) / SPARK_BUCKETS;
  const spark = (key: string, t: number, n: number) => {
    let arr = sparks.get(key);
    if (!arr) sparks.set(key, (arr = new Array<number>(SPARK_BUCKETS).fill(0)));
    const i = Math.min(SPARK_BUCKETS - 1, Math.floor((t - from) / sparkMs));
    if (i >= 0) arr[i]! += n;
  };
  if (source === 'raw') {
    current = rawPeriod(inRange);
    series = timeSeries(inRange, bucketMs, from, now);
    heatmap = heatmapByDayHour(inRange);
    for (const log of inRange) spark(stepKeyOf(log), log.start, 1);
  } else {
    const rollups = history.rollups.filter((r) => r.hour >= hourOf(from));
    current = rollupPeriod(rollups, hourOf(from), Infinity);
    series = timeSeriesFromRollups(rollups, bucketMs, from, now);
    heatmap = heatmapFromRollups(rollups, from, now);
    for (const r of rollups) spark(r.stepKey, Math.max(r.hour, from), r.count);
  }

  // The previous period, compared like for like: raw with raw when raw rows cover both periods,
  // otherwise rollups with rollups (a 25 % bucket error on one side only would swamp real changes).
  let kpiChange: PeriodChange | null = null;
  const stepChange = new Map<string, PeriodChange>();
  if (span !== null) {
    const prevFrom = from - span;
    const previousCoverage = coverage(clip(prevFrom, from), prevFrom, from);
    if (previousCoverage >= MIN_COMPARE_COVERAGE && currentCoverage > 0) {
      let before: Period;
      let after: Period;
      if (prevFrom >= history.rawFrom) {
        before = rawPeriod(data.logsBetween(prevFrom, from - 1));
        after = current;
      } else {
        before = rollupPeriod(history.rollups, hourOf(prevFrom), hourOf(from));
        after = source === 'rollups' ? current : rollupPeriod(history.rollups, hourOf(from), Infinity);
      }
      if (before.kpis.executions > 0) {
        kpiChange = change(kpiComparable(after.kpis), currentCoverage, kpiComparable(before.kpis), previousCoverage);
        const beforeByKey = new Map(before.stats.map((s) => [s.key, s]));
        for (const s of after.stats) {
          const b = beforeByKey.get(s.key);
          stepChange.set(s.key, b ? change(s, currentCoverage, b, previousCoverage) : { count: null, errorRate: null, p95: null });
        }
      }
    }
  }

  const steps: DashboardStep[] = current.stats.map((s) => {
    const reg = s.stepId ? data.steps.get(s.stepId) : undefined;
    return {
      ...s,
      spark: sparks.get(s.key) ?? new Array<number>(SPARK_BUCKETS).fill(0),
      change: stepChange.get(s.key) ?? null,
      stepName: reg?.name ?? null,
      stage: reg?.stage ?? null,
      filteringAttributes: reg ? reg.filteringAttributes : undefined,
    };
  });
  return {
    range,
    from,
    to: now,
    bucketMs,
    source,
    kpis: current.kpis,
    change: kpiChange,
    coverage: currentCoverage,
    series,
    heatmap,
    steps,
    findings: insights({
      now,
      from,
      to: now,
      steps,
      logs: inRange,
      rollups: history.rollups,
      jobs: data.jobs,
      flowRuns: data.flowRunsBetween(from, now),
      flowEvents: data.flowEvents,
      settings: caps?.settings ?? null,
      canReadTraceText: caps?.canReadTraceText ?? null,
      gaps: collectedGaps,
      ...(thresholds ? { thresholds } : {}),
    }),
    gaps: rangeGaps,
    oldest,
    platform: { ...summarizePlatformStats(history.pluginStats ?? [], from, now), canRead: caps?.canReadPluginStats ?? null },
  };
}
