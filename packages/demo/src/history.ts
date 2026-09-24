// Older demo history, as rollups only. The generator makes two weeks of raw rows; a real install
// that has been open for months would hold rollups well beyond that (raw rows are deleted after 30
// days). This replays the first generated week (before the ERP "deployment") back to `days` ago,
// with slowly shrinking volume and some noise, and leaves a three-day gap where "the app was
// closed", so long-range trends and coverage bands have something to show.
import { HOUR_MS, hourOf, toSparse, addSparse, createHistogram, type StepHourRollup } from '@dvt/core';
import { Rng } from './random.ts';

const DAY = 24 * HOUR_MS;
const WEEK = 7 * DAY;

export interface DemoHistory {
  rollups: StepHourRollup[];
  /** Periods with no data collected. */
  gaps: Array<[number, number]>;
  /** Raw rows are complete from here on (the start of the generated raw history). */
  rawFrom: number;
}

function scaleSparse(sparse: number[], f: number, rng: Rng): number[] {
  const dense = addSparse(createHistogram(), sparse);
  for (let i = 0; i < dense.length; i++) {
    if (!dense[i]) continue;
    // Random rounding keeps small counts from all rounding to zero or all staying put.
    const v = dense[i]! * f;
    dense[i] = Math.floor(v) + (rng.next() < v - Math.floor(v) ? 1 : 0);
  }
  return toSparse(dense);
}

const total = (sparse: number[]) => sparse.reduce((sum, v, i) => (i % 2 ? sum + v : sum), 0);

/**
 * Builds rollups for [now − days, rawFrom) from the rollups of the week starting at `rawFrom`.
 * `recent` must contain that week.
 */
export function demoHistory(recent: readonly StepHourRollup[], options: { now: number; rawFrom: number; days?: number; seed?: number }): DemoHistory {
  const { now, rawFrom } = options;
  const rng = new Rng(options.seed ?? 90);
  const start = hourOf(now - (options.days ?? 90) * DAY);
  const reference = new Map<number, StepHourRollup[]>();
  for (const r of recent) {
    if (r.hour < rawFrom || r.hour >= rawFrom + WEEK) continue;
    const list = reference.get(r.hour);
    if (list) list.push(r);
    else reference.set(r.hour, [r]);
  }
  const gap: [number, number] = [hourOf(now - 55 * DAY), hourOf(now - 52 * DAY)];
  const rollups: StepHourRollup[] = [];
  for (let hour = start; hour < rawFrom; hour += HOUR_MS) {
    if (hour >= gap[0] && hour < gap[1]) continue;
    const weeksBack = Math.ceil((rawFrom - hour) / WEEK);
    const source = reference.get(hour + weeksBack * WEEK);
    if (!source) continue;
    // Volume grows over time: three months ago it was about 70 % of today's.
    const age = (rawFrom - hour) / (now - start);
    const f = (1 - 0.3 * age) * (0.9 + 0.2 * rng.next());
    for (const r of source) {
      const hist = scaleSparse(r.hist, f, rng);
      const count = total(hist);
      if (count === 0) continue;
      const ctorHist = r.ctorCount ? scaleSparse(r.ctorHist, count / r.count, rng) : [];
      const ctorCount = total(ctorHist);
      const share = count / r.count;
      rollups.push({
        ...r,
        id: `${r.stepKey}@${hour}`,
        hour,
        count,
        errors: Math.min(count, Math.round(r.errors * share)),
        sumMs: Math.round(r.sumMs * share),
        hist,
        ctorCount,
        ctorSumMs: r.ctorCount ? Math.round((r.ctorSumMs / r.ctorCount) * ctorCount) : 0,
        ctorHist,
        textKnown: Math.min(count, Math.round(r.textKnown * share)),
        truncated: Math.min(count, Math.round(r.truncated * share)),
      });
    }
  }
  return { rollups, gaps: [gap], rawFrom };
}
