import { describe, expect, it } from 'vitest';
import { newSnapshots, snapshotKey, summarizePlatformStats } from './platform.ts';
import type { PluginTypeStatRecord, PluginTypeStatSnapshot } from './records.ts';
import { T0 } from './test-builders.ts';

const H = 3_600_000;
const stat = (p: Partial<PluginTypeStatRecord> = {}): PluginTypeStatRecord => ({
  id: 'stat-a',
  pluginTypeId: 'type-a',
  typeName: 'Harbor.A',
  executeCount: 100,
  failureCount: 2,
  failurePercent: 2,
  crashCount: 0,
  crashPercent: 0,
  crashContributionPercent: 0,
  averageExecuteMs: 40,
  terminateCpuPercent: 0,
  terminateMemoryPercent: 0,
  terminateHandlesPercent: 0,
  terminateOtherPercent: 0,
  modifiedOn: T0,
  ...p,
});
const snap = (p: Partial<PluginTypeStatRecord> = {}, takenAt = p.modifiedOn ?? T0): PluginTypeStatSnapshot => {
  const r = stat(p);
  return { ...r, key: snapshotKey(r), takenAt };
};

describe('newSnapshots', () => {
  it('keeps one snapshot per version of a row', () => {
    const rows = [stat(), stat({ id: 'stat-b' })];
    const first = newSnapshots(rows, new Set(), T0 + 5);
    expect(first.map((s) => [s.key, s.takenAt])).toEqual([
      [`stat-a@${T0}`, T0 + 5],
      [`stat-b@${T0}`, T0 + 5],
    ]);
    // Re-reading unchanged rows adds nothing; an updated row adds a new version.
    const known = new Set(first.map((s) => s.key));
    expect(newSnapshots(rows, known, T0 + 10)).toEqual([]);
    expect(newSnapshots([stat({ modifiedOn: T0 + H })], known, T0 + H + 5).map((s) => s.key)).toEqual([`stat-a@${T0 + H}`]);
  });
});

describe('summarizePlatformStats', () => {
  it('reports the latest values, the series in range and the refresh cadence', () => {
    const snaps = [
      snap({ modifiedOn: T0, executeCount: 100 }),
      snap({ modifiedOn: T0 + H, executeCount: 150 }),
      snap({ modifiedOn: T0 + 2 * H, executeCount: 180 }),
      snap({ id: 'stat-b', typeName: 'Harbor.B', modifiedOn: T0 + 2 * H, executeCount: 5 }),
    ];
    const s = summarizePlatformStats(snaps, T0 + H, T0 + 3 * H);
    expect(s.rows.map((r) => [r.latest.typeName, r.latest.executeCount, r.executeSeries, r.executeChange])).toEqual([
      ['Harbor.A', 180, [150, 180], 30],
      ['Harbor.B', 5, [5], null],
    ]);
    expect(s).toMatchObject({ snapshots: 4, refreshMs: H, behaviour: 'rising', since: T0 });
  });

  it('notices counters that drop (a rolling window or a reset)', () => {
    const s = summarizePlatformStats([snap({ modifiedOn: T0, executeCount: 100 }), snap({ modifiedOn: T0 + 3 * H, executeCount: 60 })], 0, Infinity);
    expect(s.behaviour).toBe('drops');
    expect(s.refreshMs).toBe(3 * H);
  });

  it('cannot tell anything from single versions', () => {
    expect(summarizePlatformStats([snap()], 0, Infinity)).toMatchObject({ behaviour: 'unknown', refreshMs: null });
    expect(summarizePlatformStats([], 0, Infinity)).toMatchObject({ rows: [], snapshots: 0, since: null, behaviour: 'unknown' });
  });

  it('takes the median interval across rows', () => {
    const s = summarizePlatformStats(
      [snap({ modifiedOn: T0 }), snap({ modifiedOn: T0 + H }), snap({ modifiedOn: T0 + 2 * H }), snap({ id: 'b', modifiedOn: T0 }), snap({ id: 'b', modifiedOn: T0 + 10 * H })],
      0,
      Infinity,
    );
    expect(s.refreshMs).toBe(H);
  });
});
