// Demo `plugintypestatistic` rows, computed from the generated executions. What the real counters
// cover is undocumented (spike S8); the demo models one plausible answer, a rolling 24-hour window
// refreshed every hour, so the platform panel has snapshots to show. The panel only ever describes
// what it observed.
import { HOUR_MS, snapshotKey, type PluginTypeStatRecord, type PluginTypeStatSnapshot } from '@dvt/core';

type Raw = Record<string, unknown>;

const FV = '@OData.Community.Display.V1.FormattedValue';
const WINDOW_HOURS = 24;

/** A stable GUID-shaped id from a name (FNV-1a), so the same plug-in type keeps its ids. */
export function stableGuid(name: string): string {
  let hex = '';
  for (let round = 0; hex.length < 32; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
    hex += h.toString(16).padStart(8, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface HourBucket {
  count: number;
  failures: number;
  sumMs: number;
}

/** Hourly counts per plug-in type from raw trace log rows. */
function hourlyByType(traceLogs: readonly Raw[]): Map<string, Map<number, HourBucket>> {
  const out = new Map<string, Map<number, HourBucket>>();
  for (const r of traceLogs) {
    const type = String(r['typename']);
    const hour = Math.floor(Date.parse(String(r['performanceexecutionstarttime'])) / HOUR_MS) * HOUR_MS;
    let hours = out.get(type);
    if (!hours) out.set(type, (hours = new Map()));
    const b = hours.get(hour) ?? { count: 0, failures: 0, sumMs: 0 };
    b.count++;
    if (r['exceptiondetails']) b.failures++;
    b.sumMs += Number(r['performanceexecutionduration']);
    hours.set(hour, b);
  }
  return out;
}

function statAt(type: string, hours: Map<number, HourBucket>, at: number): PluginTypeStatRecord {
  let count = 0;
  let failures = 0;
  let sumMs = 0;
  for (let h = at - WINDOW_HOURS * HOUR_MS; h < at; h += HOUR_MS) {
    const b = hours.get(h);
    if (!b) continue;
    count += b.count;
    failures += b.failures;
    sumMs += b.sumMs;
  }
  return {
    id: stableGuid(`stat:${type}`),
    pluginTypeId: stableGuid(`type:${type}`),
    typeName: type,
    executeCount: count,
    failureCount: failures,
    failurePercent: count ? Math.round((failures / count) * 100) : 0,
    crashCount: 0,
    crashPercent: 0,
    crashContributionPercent: 0,
    averageExecuteMs: count ? Math.round(sumMs / count) : 0,
    terminateCpuPercent: 0,
    terminateMemoryPercent: 0,
    terminateHandlesPercent: 0,
    terminateOtherPercent: 0,
    modifiedOn: at,
  };
}

const toRaw = (s: PluginTypeStatRecord): Raw => ({
  plugintypestatisticid: s.id,
  _plugintypeid_value: s.pluginTypeId,
  [`_plugintypeid_value${FV}`]: s.typeName,
  '_plugintypeid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'plugintype',
  executecount: s.executeCount,
  failurecount: s.failureCount,
  failurepercent: s.failurePercent,
  crashcount: s.crashCount,
  crashpercent: s.crashPercent,
  crashcontributionpercent: s.crashContributionPercent,
  averageexecutetimeinmilliseconds: s.averageExecuteMs,
  terminatecpucontributionpercent: s.terminateCpuPercent,
  terminatememorycontributionpercent: s.terminateMemoryPercent,
  terminatehandlescontributionpercent: s.terminateHandlesPercent,
  terminateothercontributionpercent: s.terminateOtherPercent,
  modifiedon: new Date(s.modifiedOn).toISOString().replace('.000Z', 'Z'),
});

/** The statistic rows as the Web API returns them at `now` (last refreshed at the top of the hour). */
export function demoPluginTypeStatistics(traceLogs: readonly Raw[], now: number): Raw[] {
  const at = Math.floor(now / HOUR_MS) * HOUR_MS;
  return [...hourlyByType(traceLogs)].map(([type, hours]) => toRaw(statAt(type, hours, at))).sort((a, b) => String(a['plugintypestatisticid']).localeCompare(String(b['plugintypestatisticid'])));
}

/** Snapshots the app would have kept had it been open since `from`: one per hourly refresh, before the current one. */
export function demoPluginStatHistory(traceLogs: readonly Raw[], from: number, now: number): PluginTypeStatSnapshot[] {
  const last = Math.floor(now / HOUR_MS) * HOUR_MS;
  const out: PluginTypeStatSnapshot[] = [];
  for (const [type, hours] of hourlyByType(traceLogs)) {
    for (let at = Math.ceil(from / HOUR_MS) * HOUR_MS + WINDOW_HOURS * HOUR_MS; at < last; at += HOUR_MS) {
      const stat = statAt(type, hours, at);
      out.push({ ...stat, key: snapshotKey(stat), takenAt: at + 2 * 60_000 });
    }
  }
  return out;
}
