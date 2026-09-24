// Rule-based insights: pure functions over the dashboard's statistics, rollups, system jobs and flow
// runs. Every insight says what it saw (evidence) and, where the explorer can show the rows behind
// it, which query does.
import { formatCount, formatDuration, formatPercent } from './format.ts';
import { histogramQuantileInterpolated } from './histogram.ts';
import type { AsyncOperationRecord, FlowEventRecord, FlowRunRecord, OrganizationSettings, TraceLogRecord } from './records.ts';
import { aggregateRollups, HOUR_MS, hourOf, type StepHourRollup } from './rollup.ts';
import { stepKeyOf, type StepStats } from './stats.ts';

export type InsightSeverity = 'critical' | 'warning' | 'info';

export type InsightRule =
  | 'loopDepth'
  | 'reentry'
  | 'noFilter'
  | 'slowSync'
  | 'heavyConstructor'
  | 'failing'
  | 'errorSpike'
  | 'retryStorm'
  | 'truncatedText'
  | 'tracingOff'
  | 'tracingExceptions'
  | 'textHidden'
  | 'flowFailing'
  | 'flowDataIncomplete'
  | 'syncGap';

export interface Insight {
  id: string;
  rule: InsightRule;
  severity: InsightSeverity;
  title: string;
  detail: string;
  /** What was measured, one fact per line. */
  evidence: string[];
  /** Explorer query that lists the executions behind the insight. */
  query?: string;
  /** Time range for {@link query} when it differs from the dashboard's (the error spike looks at the last 24 h). */
  queryRange?: '24h';
}

/** Rule thresholds. Every one can be changed in the dashboard's settings. */
export interface InsightThresholds {
  /** Possible loop: executions at this depth or deeper. */
  loopDepth: number;
  /** Re-entry: one step running at this many different depths of one operation. */
  reentryDepths: number;
  /** Update step without filtering attributes: runs per day. */
  noFilterRunsPerDay: number;
  /** Slow sync step: p95 above this (ms). */
  slowSyncP95Ms: number;
  /** Heavy constructor: average constructor time above this share of the average execution time… */
  heavyCtorShare: number;
  /** …or a constructor p95 above this (ms). */
  heavyCtorP95Ms: number;
  /** Failing step: at least this many errors… */
  failingMinErrors: number;
  /** …and at least this error rate. */
  failingRate: number;
  /** Error spike: last-24-h error rate at least this many times the previous 7 days'… */
  spikeFactor: number;
  /** …with at least this many errors in the last 24 h. */
  spikeMinErrors: number;
  /** Retry storm: jobs of one step or workflow that needed retries… */
  retriedJobs: number;
  /** …or jobs of one step or workflow still waiting. */
  waitingJobs: number;
  /** Truncated traces: share of a step's trace texts at the 10 KB limit. */
  truncatedShare: number;
  /** Sync gap: periods without data collection longer than this (hours). */
  syncGapHours: number;
}

export const DEFAULT_THRESHOLDS: InsightThresholds = {
  loopDepth: 6,
  reentryDepths: 3,
  noFilterRunsPerDay: 100,
  slowSyncP95Ms: 2000,
  heavyCtorShare: 0.2,
  heavyCtorP95Ms: 100,
  failingMinErrors: 5,
  failingRate: 0.03,
  spikeFactor: 3,
  spikeMinErrors: 10,
  retriedJobs: 3,
  waitingJobs: 50,
  truncatedShare: 0.1,
  syncGapHours: 24,
};

/** Keeps known, finite, non-negative values and fills the rest with defaults. */
export function resolveThresholds(partial: Partial<Record<keyof InsightThresholds, unknown>> | null | undefined): InsightThresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  if (!partial) return out;
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof InsightThresholds>) {
    const v = partial[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

/** A step as the dashboard shows it: statistics plus what its registration says. */
export interface InsightStep extends StepStats {
  /** `null` = no filtering attributes; `undefined` = registration unknown. */
  filteringAttributes?: string[] | null | undefined;
}

export interface InsightInput {
  now: number;
  /** The dashboard's range. */
  from: number;
  to: number;
  steps: readonly InsightStep[];
  /** Raw trace logs in the range (may cover only its recent part). */
  logs: readonly TraceLogRecord[];
  /** Rollups covering at least the range and the 8 days before `now`. */
  rollups: readonly StepHourRollup[];
  jobs: readonly AsyncOperationRecord[];
  flowRuns: readonly FlowRunRecord[];
  flowEvents: readonly FlowEventRecord[];
  settings: OrganizationSettings | null;
  canReadTraceText: boolean | null;
  /** Periods when no data was collected (not counting the time before local history starts). */
  gaps: ReadonlyArray<readonly [number, number]>;
  thresholds?: Partial<InsightThresholds>;
}

const DAY_MS = 24 * HOUR_MS;
const RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };
const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
const stepQuery = (s: { stepId: string | null; typeName: string }) => (s.stepId ? `step:${s.stepId}` : `type:${quote(s.typeName)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;
const where = (s: { messageName: string; primaryEntity: string | null }) => `${s.messageName} of ${s.primaryEntity ?? 'no table'}`;
const shortDate = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/** Evaluates every rule. Sorted by severity, then by rule order. */
export function insights(input: InsightInput): Insight[] {
  const t = resolveThresholds(input.thresholds);
  const out = [
    ...loopRules(input, t),
    ...stepRules(input, t),
    ...retryRules(input, t),
    ...flowRules(input),
    ...environmentRules(input, t),
  ];
  return out.map((insight, i) => ({ insight, i })).sort((a, b) => RANK[a.insight.severity] - RANK[b.insight.severity] || a.i - b.i).map((x) => x.insight);
}

function loopRules(input: InsightInput, t: InsightThresholds): Insight[] {
  const out: Insight[] = [];
  const deep = new Map<string, number>();
  for (const l of input.logs) if (l.depth >= t.loopDepth && l.correlationId) deep.set(l.correlationId, Math.max(deep.get(l.correlationId) ?? 0, l.depth));
  let olderDepth = 0;
  for (const r of input.rollups) if (r.hour >= hourOf(input.from) && r.hour <= input.to) olderDepth = Math.max(olderDepth, r.maxDepth);
  if (deep.size > 0) {
    const maxDepth = Math.max(...deep.values());
    out.push({
      id: 'deep',
      rule: 'loopDepth',
      severity: 'critical',
      title: `Depth ${maxDepth} reached in ${plural(deep.size, 'operation')}`,
      detail: 'Executions this deep usually mean plug-ins are updating each other in a loop. Dataverse stops the chain at depth 8.',
      evidence: [`${plural(deep.size, 'operation')} with executions at depth ${t.loopDepth} or deeper`, `Deepest: ${maxDepth}`],
      query: `depth>=${t.loopDepth}`,
    });
  } else if (olderDepth >= t.loopDepth) {
    out.push({
      id: 'deep',
      rule: 'loopDepth',
      severity: 'critical',
      title: `Depth ${olderDepth} reached`,
      detail: 'Executions this deep usually mean plug-ins are updating each other in a loop. They are older than the executions kept locally, so only the hourly summaries remain.',
      evidence: [`Deepest execution in the hourly summaries: depth ${olderDepth}`],
    });
  }

  // Re-entry: one step running at several depths of the same operation. Two depths can be innocent
  // (an account update that updates a parent account); a chain of them is how loops look.
  const byOperation = new Map<string, Map<string, { depths: Set<number>; log: TraceLogRecord }>>();
  for (const l of input.logs) {
    if (!l.correlationId) continue;
    let steps = byOperation.get(l.correlationId);
    if (!steps) byOperation.set(l.correlationId, (steps = new Map()));
    const key = stepKeyOf(l);
    const entry = steps.get(key);
    if (entry) entry.depths.add(l.depth);
    else steps.set(key, { depths: new Set([l.depth]), log: l });
  }
  // Steps that re-enter in the same operations are one loop, so they're reported together.
  const loops = new Map<string, { logs: TraceLogRecord[]; operations: number; example: string; depths: number[]; exampleLog: TraceLogRecord }>();
  for (const [correlationId, steps] of byOperation) {
    const looping = [...steps].filter(([, e]) => e.depths.size >= t.reentryDepths).sort(([a], [b]) => (a < b ? -1 : 1));
    if (looping.length === 0) continue;
    const key = looping.map(([k]) => k).join('+');
    const deepest = looping.reduce((best, cur) => (cur[1].depths.size > best[1].depths.size ? cur : best));
    const loop = loops.get(key) ?? { logs: looping.map(([, e]) => e.log), operations: 0, example: correlationId, depths: [], exampleLog: deepest[1].log };
    loop.operations++;
    const depths = [...new Set(looping.flatMap(([, e]) => [...e.depths]))].sort((a, b) => a - b);
    if (depths.length > loop.depths.length) {
      loop.example = correlationId;
      loop.depths = depths;
    }
    loops.set(key, loop);
  }
  for (const [key, loop] of loops) {
    const names = loop.logs.map((l) => l.typeName);
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
    out.push({
      id: `reentry:${key}`,
      rule: 'reentry',
      severity: 'warning',
      title: names.length === 1 ? `${list} runs again inside its own operations` : `${list} trigger each other`,
      detail:
        names.length === 1
          ? `It ran at several depths of one operation, so something it does (directly or through other steps) makes ${where(loop.exampleLog)} fire again. Check what it updates, and add filtering attributes or a depth guard.`
          : 'Each of these ran at several depths of the same operations, so they keep firing one another. Break the cycle: add filtering attributes, skip updates that change nothing, or add a depth guard.',
      evidence: [
        `${plural(loop.operations, 'operation')} where ${names.length === 1 ? 'it' : 'each'} ran at ${t.reentryDepths} or more depths`,
        ...loop.logs.map((l) => `${l.typeName}: ${where(l)}`).slice(0, names.length === 1 ? 0 : 5),
        `Depths ${loop.depths.join(', ')} in operation ${loop.example}`,
      ],
      query: `corr:${loop.example}`,
    });
  }
  return out;
}

function stepRules(input: InsightInput, t: InsightThresholds): Insight[] {
  const out: Insight[] = [];
  const days = Math.max((input.to - input.from) / DAY_MS, 1 / 24);
  const inRange = aggregateRollups(input.rollups, hourOf(input.from), input.to + 1);
  const spikes = errorSpikes(input, t);
  for (const s of input.steps) {
    const perDay = s.count / days;
    if (s.messageName === 'Update' && s.filteringAttributes === null && perDay >= t.noFilterRunsPerDay) {
      out.push({
        id: `nofilter:${s.key}`,
        rule: 'noFilter',
        severity: 'warning',
        title: `${s.typeName} has no filtering attributes`,
        detail: `It runs on every update of ${s.primaryEntity ?? 'its table'}: ${formatCount(Math.round(perDay))} runs a day. Set filtering attributes so it only runs when the columns it reads change.`,
        evidence: [`Registered on ${where(s)} with no filtering attributes`, `${plural(s.count, 'run')} in the range, about ${formatCount(Math.round(perDay))} a day`],
        query: `${stepQuery(s)} msg:Update`,
      });
    }
    if (s.mode === 'sync' && s.count >= 10 && s.p95 > t.slowSyncP95Ms) {
      out.push({
        id: `slow:${s.key}`,
        rule: 'slowSync',
        severity: 'warning',
        title: `${s.typeName} is slow (p95 ${formatDuration(s.p95)})`,
        detail: `It runs synchronously on ${where(s)}, so users wait for it when they save. Move slow work to an async step, or make it faster.`,
        evidence: [`p50 ${formatDuration(s.p50)} · p95 ${formatDuration(s.p95)} · max ${formatDuration(s.max)}`, `${plural(s.count, 'run')} in the range`],
        query: `${stepQuery(s)} dur>${Math.round(t.slowSyncP95Ms)}`,
      });
    }
    const agg = inRange.get(s.key);
    if (agg && agg.ctorCount >= 10) {
      const avgCtor = agg.ctorSumMs / agg.ctorCount;
      const p95Ctor = histogramQuantileInterpolated(agg.ctorHist, 0.95) ?? 0;
      const share = s.avgMs > 0 ? avgCtor / s.avgMs : 0;
      // A share of a tiny duration isn't worth reporting: 2 ms of constructor in a 5 ms step is fine.
      if (p95Ctor > t.heavyCtorP95Ms || (share > t.heavyCtorShare && avgCtor >= 10)) {
        out.push({
          id: `ctor:${s.key}`,
          rule: 'heavyConstructor',
          severity: 'warning',
          title: `${s.typeName} has a heavy constructor`,
          detail: 'The constructor runs whenever the platform creates a new instance of the plug-in. Move work such as reading configuration or creating clients out of it, and cache what can be cached.',
          evidence: [`Constructor: average ${formatDuration(avgCtor)}, p95 about ${formatDuration(p95Ctor)}`, `That is ${formatPercent(share)} of the average execution (${formatDuration(s.avgMs)})`],
          query: stepQuery(s),
        });
      }
    }
    if (agg && agg.textKnown >= 20 && agg.truncated / agg.textKnown > t.truncatedShare) {
      out.push({
        id: `truncated:${s.key}`,
        rule: 'truncatedText',
        severity: 'warning',
        title: `${s.typeName} writes too much trace text`,
        detail: 'Trace text is cut at 10 KB and the start is lost, which is usually the context you need. Trace less, or trace summaries instead of payloads.',
        evidence: [`${formatCount(agg.truncated)} of ${plural(agg.textKnown, 'trace')} with text are at the 10 KB limit (${formatPercent(agg.truncated / agg.textKnown)})`],
        query: stepQuery(s),
      });
    }
    const spike = spikes.get(s.key);
    if (spike) out.push(spike);
    else if (s.errors >= t.failingMinErrors && s.errorRate >= t.failingRate) {
      out.push({
        id: `errors:${s.key}`,
        rule: 'failing',
        severity: s.errorRate >= 0.2 ? 'critical' : 'warning',
        title: `${s.typeName} fails ${formatPercent(s.errorRate)} of the time`,
        detail: `${formatCount(s.errors)} of ${plural(s.count, 'execution')} threw an exception.`,
        evidence: [`${formatCount(s.errors)} errors in ${plural(s.count, 'run')} (${formatPercent(s.errorRate)})`],
        query: `${stepQuery(s)} err`,
      });
    }
  }
  return out;
}

/** Steps whose error rate in the last 24 h is well above their previous 7 days. */
function errorSpikes(input: InsightInput, t: InsightThresholds): Map<string, Insight> {
  const out = new Map<string, Insight>();
  const dayStart = hourOf(input.now - DAY_MS);
  const recent = aggregateRollups(input.rollups, dayStart, Infinity);
  const baseline = aggregateRollups(input.rollups, dayStart - 7 * DAY_MS, dayStart);
  for (const [key, r] of recent) {
    const b = baseline.get(key);
    // Without enough history there's no baseline to spike against; the "failing" rule covers it.
    if (!b || b.count < 50 || r.errors < t.spikeMinErrors) continue;
    const rate = r.errors / r.count;
    const before = b.errors / b.count;
    if (rate <= t.spikeFactor * before || rate === 0) continue;
    out.set(key, {
      id: `spike:${key}`,
      rule: 'errorSpike',
      severity: rate >= 0.2 ? 'critical' : 'warning',
      title: before === 0 ? `${r.typeName} started failing` : `${r.typeName} fails ${(rate / before).toFixed(rate / before >= 10 ? 0 : 1)}× as often as usual`,
      detail: `Its error rate in the last 24 hours is ${formatPercent(rate)}, against ${formatPercent(before)} in the 7 days before. Something changed: a deployment, a dependency, or the data.`,
      evidence: [`Last 24 h: ${formatCount(r.errors)} of ${plural(r.count, 'run')} failed (${formatPercent(rate)})`, `7 days before: ${formatCount(b.errors)} of ${plural(b.count, 'run')} (${formatPercent(before)})`],
      query: `${stepQuery(r)} err`,
      queryRange: '24h',
    });
  }
  return out;
}

function retryRules(input: InsightInput, t: InsightThresholds): Insight[] {
  const groups = new Map<string, { name: string; stepId: string | null; retried: number; retries: number; failedAfterRetry: number; waiting: number }>();
  for (const j of input.jobs) {
    if (j.createdOn < input.from || j.createdOn > input.to) continue;
    const key = j.stepId ?? j.workflowId ?? j.name;
    const g = groups.get(key) ?? { name: j.name.replace(/:.*$/, ''), stepId: j.stepId, retried: 0, retries: 0, failedAfterRetry: 0, waiting: 0 };
    if (j.retryCount > 0) {
      g.retried++;
      g.retries += j.retryCount;
      if (j.statusCode === 31) g.failedAfterRetry++;
    }
    if (j.statusCode === 0 || j.statusCode === 10) g.waiting++;
    groups.set(key, g);
  }
  const out: Insight[] = [];
  for (const [key, g] of groups) {
    if (g.retried < t.retriedJobs && g.waiting < t.waitingJobs) continue;
    const evidence: string[] = [];
    if (g.retried) evidence.push(`${plural(g.retried, 'job')} needed retries (${plural(g.retries, 'retry', 'retries')} in total)`);
    if (g.failedAfterRetry) evidence.push(`${plural(g.failedAfterRetry, 'job')} still failed after retrying`);
    if (g.waiting) evidence.push(`${plural(g.waiting, 'job')} waiting now`);
    out.push({
      id: `retry:${key}`,
      rule: 'retryStorm',
      severity: g.failedAfterRetry > 0 || g.waiting >= t.waitingJobs ? 'warning' : 'info',
      title: g.retried >= t.retriedJobs ? `${g.name} keeps retrying` : `${plural(g.waiting, 'job')} of ${g.name} are waiting`,
      detail: 'Retries and waiting jobs hold up the async queue for everything else. Look at the first failure of a job: a dependency that is down, throttling, or a lock.',
      evidence,
      ...(g.stepId ? { query: `step:${g.stepId} err` } : {}),
    });
  }
  return out;
}

function flowRules(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const byFlow = new Map<string, { name: string; total: number; failed: number }>();
  for (const r of input.flowRuns) {
    if (r.start < input.from || r.start > input.to) continue;
    const key = r.workflowId ?? r.flowName ?? 'unknown';
    const s = byFlow.get(key) ?? { name: r.flowName ?? 'Unnamed flow', total: 0, failed: 0 };
    s.total++;
    if (r.status === 'failed') s.failed++;
    byFlow.set(key, s);
  }
  for (const [key, s] of byFlow) {
    const rate = s.failed / s.total;
    if (s.failed >= 5 && rate >= 0.03) {
      out.push({
        id: `flow-errors:${key}`,
        rule: 'flowFailing',
        severity: rate >= 0.2 ? 'critical' : 'warning',
        title: `Cloud flow "${s.name}" fails ${formatPercent(rate)} of the time`,
        detail: 'Open a failed run’s record story to see what triggered it.',
        evidence: [`${formatCount(s.failed)} of ${plural(s.total, 'run')} failed`],
      });
    }
  }
  const events = input.flowEvents.filter((e) => e.eventType === 'FlowRunIngestion' && e.createdOn >= input.from && e.createdOn <= input.to);
  if (events.length) {
    out.push({
      id: 'flow-gaps',
      rule: 'flowDataIncomplete',
      severity: 'info',
      title: 'Flow run history may be incomplete',
      detail: `Dataverse reported ${plural(events.length, 'flow-run ingestion problem')} in this range, so some runs may be missing and flow links may be absent.`,
      evidence: events.slice(0, 3).map((e) => `${shortDate(e.createdOn)} UTC: ${e.name ?? 'ingestion problem'}`),
    });
  }
  return out;
}

function environmentRules(input: InsightInput, t: InsightThresholds): Insight[] {
  const out: Insight[] = [];
  const setting = input.settings?.pluginTraceLogSetting;
  if (setting === 0) {
    out.push({ id: 'tracing-off', rule: 'tracingOff', severity: 'info', title: 'Plug-in trace logging is Off', detail: 'No new executions are being logged, so only platform statistics are current. Set it to Exceptions or All in the environment settings.', evidence: ['Organization setting: plug-in trace log = Off'] });
  } else if (setting === 1) {
    out.push({ id: 'tracing-exceptions', rule: 'tracingExceptions', severity: 'info', title: 'Only failures are logged', detail: 'Trace logging is set to Exceptions, so volumes and durations only cover failing executions.', evidence: ['Organization setting: plug-in trace log = Exceptions'] });
  }
  if (input.canReadTraceText === false) {
    out.push({ id: 'no-text', rule: 'textHidden', severity: 'info', title: 'Trace text is hidden', detail: 'Only System Administrators can read trace text, so text search covers exceptions and names only.', evidence: ['Trace text came back empty for this account'] });
  }
  const minGap = t.syncGapHours * HOUR_MS;
  const gaps = input.gaps.filter(([a, b]) => b - a >= minGap && b > input.from && a < input.to);
  if (gaps.length) {
    const total = gaps.reduce((sum, [a, b]) => sum + (b - a), 0);
    out.push({
      id: 'sync-gap',
      rule: 'syncGap',
      severity: 'info',
      title: `No data was collected for ${formatDuration(total)}`,
      detail: 'Dataverse deletes trace logs after about a day, and history is only collected while the app is open. Counts in these periods are missing, not low.',
      evidence: gaps.map(([a, b]) => `${shortDate(a)} – ${shortDate(b)} UTC`),
    });
  }
  return out;
}
