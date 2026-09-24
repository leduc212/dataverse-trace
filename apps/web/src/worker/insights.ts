// Dashboard data and rule-based findings.
import {
  computeKpis,
  computeStepStats,
  formatDuration,
  formatPercent,
  heatmapByDayHour,
  timeSeries,
  type OrganizationSettings,
  type TraceLogRecord,
} from '@dvt/core';
import type { Capabilities } from '@dvt/dataverse';
import { RANGE_MS, type DashboardData, type DashboardStep, type Finding, type RangeKey } from '../shared/api.ts';
import type { Dataset } from './dataset.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SPARK_BUCKETS = 14;

function bucketFor(range: RangeKey, spanMs: number): number {
  if (range === '1h') return 5 * 60_000;
  if (range === '24h') return HOUR;
  if (range === '7d') return 6 * HOUR;
  return spanMs > 45 * DAY ? 7 * DAY : DAY;
}

const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

export function findings(steps: DashboardStep[], logs: readonly TraceLogRecord[], days: number, settings: OrganizationSettings | null, caps: Capabilities | null): Finding[] {
  const out: Finding[] = [];
  // Loop risk: deep executions.
  const deep = new Set(logs.filter((l) => l.depth >= 6).map((l) => l.correlationId));
  if (deep.size > 0) {
    const maxDepth = Math.max(...logs.map((l) => l.depth));
    out.push({
      id: 'deep',
      severity: 'critical',
      title: `Depth ${maxDepth} reached in ${deep.size} operation${deep.size === 1 ? '' : 's'}`,
      detail: 'Executions this deep usually mean plugins are updating each other in a loop.',
      query: 'depth>=6',
    });
  }
  for (const s of steps) {
    const perDay = s.count / Math.max(days, 1 / 24);
    if (s.messageName === 'Update' && s.filteringAttributes === null && perDay >= 100) {
      out.push({
        id: `nofilter:${s.key}`,
        severity: 'warning',
        title: `${s.typeName} has no filtering attributes`,
        detail: `It runs on every update of ${s.primaryEntity ?? 'its table'}: ${Math.round(perDay).toLocaleString('en-US')} runs a day. Set filtering attributes so it only runs when the columns it reads change.`,
        query: `type:${quote(s.typeName)} msg:Update`,
      });
    }
    if (s.mode === 'sync' && s.count >= 10 && s.p95 > 2000) {
      out.push({
        id: `slow:${s.key}`,
        severity: 'warning',
        title: `${s.typeName} is slow (p95 ${formatDuration(s.p95)})`,
        detail: `It runs synchronously on ${s.messageName} of ${s.primaryEntity ?? 'its table'}, so users wait for it when they save.`,
        query: `type:${quote(s.typeName)} dur>2s`,
      });
    }
    if (s.errors >= 5 && s.errorRate >= 0.03) {
      out.push({
        id: `errors:${s.key}`,
        severity: s.errorRate >= 0.2 ? 'critical' : 'warning',
        title: `${s.typeName} fails ${formatPercent(s.errorRate)} of the time`,
        detail: `${s.errors.toLocaleString('en-US')} of ${s.count.toLocaleString('en-US')} executions threw an exception.`,
        query: `type:${quote(s.typeName)} err`,
      });
    }
  }
  if (settings?.pluginTraceLogSetting === 0) {
    out.push({ id: 'tracing-off', severity: 'info', title: 'Plug-in trace logging is Off', detail: 'No new executions are being logged. Set it to Exceptions or All in the environment settings.' });
  } else if (settings?.pluginTraceLogSetting === 1) {
    out.push({ id: 'tracing-exceptions', severity: 'info', title: 'Only failures are logged', detail: 'Trace logging is set to Exceptions, so volumes and durations only cover failing executions.' });
  }
  if (caps?.canReadTraceText === false) {
    out.push({ id: 'no-text', severity: 'info', title: 'Trace text is hidden', detail: 'Only System Administrators can read trace text, so text search covers exceptions and names only.' });
  }
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function dashboard(data: Dataset, range: RangeKey, now: number, caps: Capabilities | null, gaps: Array<[number, number]>): DashboardData {
  const span = RANGE_MS[range];
  const oldest = data.logs.length ? data.logs[data.logs.length - 1]!.start : null;
  const from = span !== null ? now - span : (oldest ?? now - DAY);
  const inRange: TraceLogRecord[] = [];
  for (const log of data.logs) {
    if (log.start < from) break;
    if (log.start <= now) inRange.push(log);
  }
  const bucketMs = bucketFor(range, now - from);
  const stats = computeStepStats(inRange);
  const sparkMs = (now - from) / SPARK_BUCKETS;
  const sparks = new Map<string, number[]>();
  for (const s of stats) sparks.set(s.key, new Array<number>(SPARK_BUCKETS).fill(0));
  for (const log of inRange) {
    const key = log.stepId ?? `${log.typeName}|${log.messageName}|${log.primaryEntity ?? ''}|${log.mode}`;
    const i = Math.min(SPARK_BUCKETS - 1, Math.floor((log.start - from) / sparkMs));
    const arr = sparks.get(key);
    if (arr && i >= 0) arr[i]!++;
  }
  const steps: DashboardStep[] = stats.map((s) => {
    const reg = s.stepId ? data.steps.get(s.stepId) : undefined;
    return {
      ...s,
      spark: sparks.get(s.key) ?? [],
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
    kpis: computeKpis(inRange, stats),
    series: timeSeries(inRange, bucketMs, from, now),
    heatmap: heatmapByDayHour(inRange),
    steps,
    findings: findings(steps, inRange, (now - from) / DAY, caps?.settings ?? null, caps),
    gaps: gaps.filter(([a, b]) => b > from && a < now),
    oldest,
  };
}
