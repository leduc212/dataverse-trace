// Aggregates over trace log records for the dashboard and explorer.
import { quantileSorted } from './histogram.ts';
import type { ExecutionMode, TraceLogRecord } from './records.ts';

export interface StepStats {
  key: string;
  stepId: string | null;
  typeName: string;
  messageName: string;
  primaryEntity: string | null;
  mode: ExecutionMode;
  count: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  max: number;
  avgMs: number;
  avgConstructorMs: number | null;
  firstSeen: number;
  lastSeen: number;
}

/** Groups by step id when known; otherwise by type + message + table + mode. */
export const stepKeyOf = (log: TraceLogRecord): string =>
  log.stepId ?? `${log.typeName}|${log.messageName}|${log.primaryEntity ?? ''}|${log.mode}`;

export function computeStepStats(logs: Iterable<TraceLogRecord>): StepStats[] {
  const groups = new Map<string, TraceLogRecord[]>();
  for (const log of logs) {
    const key = stepKeyOf(log);
    const g = groups.get(key);
    if (g) g.push(log);
    else groups.set(key, [log]);
  }
  const result: StepStats[] = [];
  for (const [key, rows] of groups) {
    const first = rows[0]!;
    const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
    const ctors = rows.map((r) => r.constructorMs).filter((v): v is number => v !== null);
    const errors = rows.filter((r) => r.exception).length;
    result.push({
      key,
      stepId: first.stepId,
      typeName: first.typeName,
      messageName: first.messageName,
      primaryEntity: first.primaryEntity,
      mode: first.mode,
      count: rows.length,
      errors,
      errorRate: errors / rows.length,
      p50: quantileSorted(durations, 0.5)!,
      p95: quantileSorted(durations, 0.95)!,
      max: durations[durations.length - 1]!,
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      avgConstructorMs: ctors.length ? ctors.reduce((a, b) => a + b, 0) / ctors.length : null,
      firstSeen: Math.min(...rows.map((r) => r.start)),
      lastSeen: Math.max(...rows.map((r) => r.start)),
    });
  }
  return result.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

export interface Kpis {
  executions: number;
  errors: number;
  errorRate: number;
  /** p95 duration of sync executions (they block the user's save). */
  p95SyncMs: number | null;
  maxDepth: number;
  slowestStep: { name: string; p95: number } | null;
  from: number | null;
  to: number | null;
}

export function computeKpis(logs: readonly TraceLogRecord[], stepStats?: readonly StepStats[]): Kpis {
  const sync = logs.filter((l) => l.mode === 'sync').map((l) => l.durationMs).sort((a, b) => a - b);
  const errors = logs.filter((l) => l.exception).length;
  const stats = stepStats ?? computeStepStats(logs);
  const slowest = [...stats].filter((s) => s.count >= 3).sort((a, b) => b.p95 - a.p95)[0];
  return {
    executions: logs.length,
    errors,
    errorRate: logs.length ? errors / logs.length : 0,
    p95SyncMs: quantileSorted(sync, 0.95),
    maxDepth: logs.reduce((m, l) => Math.max(m, l.depth), 0),
    slowestStep: slowest ? { name: slowest.typeName, p95: slowest.p95 } : null,
    from: logs.length ? Math.min(...logs.map((l) => l.start)) : null,
    to: logs.length ? Math.max(...logs.map((l) => l.start)) : null,
  };
}

export interface TimeBucket {
  start: number;
  count: number;
  errors: number;
}

/** Contiguous buckets of `bucketMs` from `from` to `to` (both inclusive of their bucket). */
export function timeSeries(logs: readonly TraceLogRecord[], bucketMs: number, from: number, to: number): TimeBucket[] {
  const first = Math.floor(from / bucketMs) * bucketMs;
  const n = Math.max(1, Math.floor((to - first) / bucketMs) + 1);
  const buckets: TimeBucket[] = Array.from({ length: n }, (_, i) => ({ start: first + i * bucketMs, count: 0, errors: 0 }));
  for (const log of logs) {
    const i = Math.floor((log.start - first) / bucketMs);
    const b = buckets[i];
    if (!b) continue;
    b.count++;
    if (log.exception) b.errors++;
  }
  return buckets;
}

export interface Heatmap {
  /** Row labels: one per calendar day (YYYY-MM-DD, local time), oldest first. */
  days: string[];
  /** counts[day][hour]. */
  counts: number[][];
  errors: number[][];
  max: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Executions per local calendar day × hour of day. */
export function heatmapByDayHour(logs: readonly TraceLogRecord[]): Heatmap {
  const index = new Map<string, { counts: number[]; errors: number[] }>();
  for (const log of logs) {
    const day = localDayKey(log.start);
    let row = index.get(day);
    if (!row) {
      row = { counts: new Array<number>(24).fill(0), errors: new Array<number>(24).fill(0) };
      index.set(day, row);
    }
    const hour = new Date(log.start).getHours();
    row.counts[hour]!++;
    if (log.exception) row.errors[hour]!++;
  }
  const days = [...index.keys()].sort();
  const counts = days.map((d) => index.get(d)!.counts);
  return { days, counts, errors: days.map((d) => index.get(d)!.errors), max: Math.max(0, ...counts.flat()) };
}
