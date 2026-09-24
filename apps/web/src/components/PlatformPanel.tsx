// Dataverse's own counters per plug-in type (`plugintypestatistic`), which keep counting with trace
// logging off. What window they cover isn't documented (spike S8), so the panel says what it has
// observed in this environment's snapshots instead of interpreting the numbers.
import { formatDuration, type PlatformSummary } from '@dvt/core';
import { Badge, Tooltip } from '@fluentui/react-components';
import { formatDay, formatShortDateTime } from '../format.ts';
import { EmptyState } from './bits.tsx';
import { Sparkline } from './charts.tsx';

const pct = (v: number | null) => (v === null ? '–' : `${v} %`);

function observed(p: PlatformSummary): string {
  if (p.snapshots === 0) return '';
  const since = p.since === null ? '' : ` since ${formatDay(p.since)}`;
  if (p.behaviour === 'unknown') return `One version of each row so far${since}. Keep the app open to see how often they refresh.`;
  const cadence = p.refreshMs === null ? '' : `Dataverse updated them about every ${formatDuration(p.refreshMs)}`;
  const shape = p.behaviour === 'drops' ? 'the counts also went down, so they look like a rolling window rather than running totals' : 'the counts only went up so far, like running totals';
  return `Seen here in ${p.snapshots.toLocaleString('en-US')} snapshots${since}: ${cadence}, and ${shape}.`;
}

export function PlatformPanel({ platform }: { platform: PlatformSummary & { canRead: boolean | null } }) {
  if (platform.canRead === false) {
    return <EmptyState title="No access to platform statistics">Reading them needs the Read privilege on Plug-in Type Statistic.</EmptyState>;
  }
  if (platform.rows.length === 0) {
    return <EmptyState title="No platform statistics yet">They appear after the next sync, once any plug-in type has run.</EmptyState>;
  }
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Counted by Dataverse for each plug-in type, even when trace logging is off or set to Exceptions. Microsoft doesn't document which period they cover. {observed(platform)}
      </p>
      <div style={{ overflow: 'auto' }}>
        <table className="data" aria-label="Platform statistics">
          <thead>
            <tr>
              <th>Plug-in type</th>
              <th className="num">Runs</th>
              <th className="num">Failures</th>
              <th className="num">Avg time</th>
              <th className="num">Crashes</th>
              <th className="num">Terminated</th>
              <th>
                Runs over time{' '}
                <Tooltip content="The run count in each stored snapshot in this range. How to read differences depends on the period the counters cover, which isn't confirmed yet (spike S8)." relationship="description">
                  <Badge size="small" appearance="outline">
                    experimental
                  </Badge>
                </Tooltip>
              </th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {platform.rows.map(({ latest: s, executeSeries }) => {
              const terminated = Math.max(s.terminateCpuPercent ?? 0, s.terminateMemoryPercent ?? 0, s.terminateHandlesPercent ?? 0, s.terminateOtherPercent ?? 0);
              return (
                <tr key={s.id}>
                  <td>{s.typeName ?? s.pluginTypeId ?? s.id}</td>
                  <td className="num">{s.executeCount.toLocaleString('en-US')}</td>
                  <td className="num">
                    {s.failureCount ? (
                      <span className="error-text">
                        {s.failureCount.toLocaleString('en-US')} ({pct(s.failurePercent)})
                      </span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td className="num">{formatDuration(s.averageExecuteMs)}</td>
                  <td className="num">{s.crashCount ? <span className="error-text">{s.crashCount.toLocaleString('en-US')}</span> : '0'}</td>
                  <td
                    className="num"
                    title={`CPU ${pct(s.terminateCpuPercent)} · memory ${pct(s.terminateMemoryPercent)} · handles ${pct(s.terminateHandlesPercent)} · other ${pct(s.terminateOtherPercent)}`}
                  >
                    {terminated ? <span className="error-text">{terminated} %</span> : '0 %'}
                  </td>
                  <td>{executeSeries.length >= 2 ? <Sparkline values={executeSeries} /> : <span className="small muted">–</span>}</td>
                  <td className="small">{formatShortDateTime(s.modifiedOn)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
