// Platform statistics (`plugintypestatistic`): what Dataverse itself counts per plug-in type. The app
// keeps a snapshot every time Dataverse updates a row, which also answers spike S8 over time: how
// often the counters refresh, and whether they only ever grow (a running total) or also drop (a
// rolling window). Until that's settled, differences between snapshots are shown as experimental.
import type { PluginTypeStatRecord, PluginTypeStatSnapshot } from './records.ts';

export const snapshotKey = (row: Pick<PluginTypeStatRecord, 'id' | 'modifiedOn'>): string => `${row.id}@${row.modifiedOn}`;

/** Snapshots for rows whose version (`modifiedOn`) isn't stored yet. */
export function newSnapshots(rows: readonly PluginTypeStatRecord[], known: ReadonlySet<string>, takenAt: number): PluginTypeStatSnapshot[] {
  return rows.filter((r) => !known.has(snapshotKey(r))).map((r) => ({ ...r, key: snapshotKey(r), takenAt }));
}

/** How the counters behaved across the stored snapshots. */
export type CounterBehaviour =
  /** Never decreased: looks like a running total. */
  | 'rising'
  /** Decreased at least once: a rolling window, or counters that get reset. */
  | 'drops'
  /** Fewer than two versions of any row. */
  | 'unknown';

export interface PlatformStatRow {
  latest: PluginTypeStatSnapshot;
  /** Execute counts of the snapshots in the range, oldest first. */
  executeSeries: number[];
  /** Change in execute count between the first and last snapshot in the range (experimental, S8). */
  executeChange: number | null;
}

export interface PlatformSummary {
  rows: PlatformStatRow[];
  snapshots: number;
  /** Median time between two versions of the same row: how often Dataverse refreshes the counters. */
  refreshMs: number | null;
  behaviour: CounterBehaviour;
  /** When the oldest stored snapshot was taken. */
  since: number | null;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Latest values per plug-in type, with the snapshots in [from, to] as a series, plus what the
 * whole snapshot history says about refresh cadence and counter behaviour.
 */
export function summarizePlatformStats(snapshots: readonly PluginTypeStatSnapshot[], from: number, to: number): PlatformSummary {
  const byRow = new Map<string, PluginTypeStatSnapshot[]>();
  for (const s of snapshots) {
    const list = byRow.get(s.id);
    if (list) list.push(s);
    else byRow.set(s.id, [s]);
  }
  const intervals: number[] = [];
  let sawTwo = false;
  let drops = false;
  const rows: PlatformStatRow[] = [];
  for (const list of byRow.values()) {
    list.sort((a, b) => a.modifiedOn - b.modifiedOn);
    for (let i = 1; i < list.length; i++) {
      sawTwo = true;
      intervals.push(list[i]!.modifiedOn - list[i - 1]!.modifiedOn);
      if (list[i]!.executeCount < list[i - 1]!.executeCount) drops = true;
    }
    const inRange = list.filter((s) => s.modifiedOn >= from && s.modifiedOn <= to);
    rows.push({
      latest: list[list.length - 1]!,
      executeSeries: inRange.map((s) => s.executeCount),
      executeChange: inRange.length >= 2 ? inRange[inRange.length - 1]!.executeCount - inRange[0]!.executeCount : null,
    });
  }
  rows.sort((a, b) => b.latest.executeCount - a.latest.executeCount || (a.latest.typeName ?? '').localeCompare(b.latest.typeName ?? ''));
  return {
    rows,
    snapshots: snapshots.length,
    refreshMs: median(intervals),
    behaviour: !sawTwo ? 'unknown' : drops ? 'drops' : 'rising',
    since: snapshots.length ? Math.min(...snapshots.map((s) => s.takenAt)) : null,
  };
}
