import { formatDuration, formatPercent } from '@dvt/core';
import { Dropdown, Option, Spinner, Switch } from '@fluentui/react-components';
import { ErrorCircleFilled, InfoRegular, WarningFilled } from '@fluentui/react-icons';
import { useState } from 'react';
import { EmptyState } from '../components/bits.tsx';
import { PlatformPanel } from '../components/PlatformPanel.tsx';
import { ThresholdsDialog } from '../components/ThresholdsDialog.tsx';
import { Heatmap, HeatmapScale, Sparkline, StackedColumns, StackedLegend } from '../components/charts.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { compactCount, formatShortDateTime, STAGE_LABELS } from '../format.ts';
import { href, navigate, useRoute } from '../router.ts';
import { DASHBOARD_RANGE_LABELS, type DashboardData, type DashboardRangeKey, type DashboardStep, type Finding, type RangeKey } from '../shared/api.ts';

/** The explorer only reads raw rows, which are kept for 30 days. */
const explorerRange = (range: DashboardRangeKey): RangeKey | undefined => (range === '24h' ? undefined : range === '90d' ? 'all' : range);

/** Changes smaller than this are shown as "no change". Estimated percentiles get a wider margin. */
const RELATIVE_NOISE = 0.05;
const ESTIMATE_NOISE = 0.1;
const POINTS_NOISE = 0.001;

/**
 * A change against the previous period, e.g. "▲ 12 %". `bad` says which direction is a problem
 * (more errors, slower); that direction is shown in the error colour.
 */
function Delta({ value, points, bad, quiet, estimate }: { value: number | null | undefined; points?: boolean; bad?: 'up'; quiet?: boolean; estimate?: boolean }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const noise = points ? POINTS_NOISE : estimate ? ESTIMATE_NOISE : RELATIVE_NOISE;
  if (Math.abs(value) < noise) return quiet ? null : <span className="delta muted">no change</span>;
  const up = value > 0;
  const text = points ? `${(Math.abs(value) * 100).toFixed(1)} pt` : Math.abs(value) >= 10 ? `×${(value + 1).toFixed(0)}` : `${Math.round(Math.abs(value) * 100)} %`;
  const worse = bad === 'up' && up;
  return (
    <span className={`delta${worse ? ' error-text' : ' muted'}`} title={`${up ? 'Up' : 'Down'} ${text} against the previous period`}>
      {up ? '▲' : '▼'} {text}
    </span>
  );
}

function Tile({ label, value, sub, tone, delta }: { label: string; value: string; sub?: string | undefined; tone?: 'critical' | undefined; delta?: React.ReactNode }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value${tone === 'critical' ? ' error-text' : ''}`}>{value}</div>
      {sub && <div className="sub ellipsis" title={sub}>{sub}</div>}
      {delta && <div className="sub">{delta}</div>}
    </div>
  );
}

function FindingRow({ f, range }: { f: Finding; range: DashboardRangeKey }) {
  const icon =
    f.severity === 'critical' ? (
      <ErrorCircleFilled className="error-text" aria-label="Critical" />
    ) : f.severity === 'warning' ? (
      <WarningFilled style={{ color: 'var(--viz-warning)' }} aria-label="Warning" />
    ) : (
      <InfoRegular aria-label="Info" />
    );
  return (
    <div className="finding">
      {icon}
      <div>
        <div className="title">{f.title}</div>
        <div className="small muted">{f.detail}</div>
        {f.evidence.length > 0 && (
          <ul className="evidence small" aria-label="Evidence">
            {f.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {f.query && (
          <button className="link small" onClick={() => navigate(href('explorer', { q: f.query, r: f.queryRange ?? explorerRange(range), v: 'executions' }))}>
            Show the executions{f.queryRange === '24h' ? ' (last 24 h)' : ''} →
          </button>
        )}
        {(f.rule === 'reentry' || f.rule === 'loopDepth') && (
          <button className="link small" style={{ marginLeft: f.query ? 12 : 0 }} onClick={() => navigate(href('graph', { r: explorerRange(range) }))}>
            See the loop in Cascades →
          </button>
        )}
      </div>
    </div>
  );
}

type SortKey = 'count' | 'errors' | 'p50' | 'p95' | 'max' | 'avgConstructorMs';

function StepTable({ steps, range, approx }: { steps: DashboardStep[]; range: DashboardRangeKey; approx: boolean }) {
  const [sort, setSort] = useState<SortKey>('count');
  const sorted = [...steps].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
  const head = (key: SortKey, label: string) => (
    <th className="num" aria-sort={sort === key ? 'descending' : 'none'}>
      <button onClick={() => setSort(key)}>
        {label}
        {sort === key ? ' ↓' : ''}
      </button>
    </th>
  );
  return (
    <div style={{ overflow: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th>Step</th>
            <th>Stage · mode</th>
            {head('count', 'Runs')}
            <th>Trend</th>
            {head('errors', 'Errors')}
            {head('p50', 'p50')}
            {head('p95', 'p95')}
            {head('max', 'Max')}
            {head('avgConstructorMs', 'Ctor avg')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr
              key={s.key}
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(href('explorer', { q: s.stepId ? `step:${s.stepId}` : `type:"${s.typeName}"`, r: explorerRange(range), v: 'executions' }))}
            >
              <td>
                <div title={s.typeName}>{s.typeName}</div>
                <div className="small muted">
                  {s.messageName} {s.primaryEntity ?? ''}
                  {s.filteringAttributes === null && s.messageName === 'Update' && ' · no filtering attributes'}
                </div>
              </td>
              <td className="small">
                {s.stage ? STAGE_LABELS[s.stage] : '–'} · {s.mode}
              </td>
              <td className="num">
                {s.count.toLocaleString('en-US')}
                <div className="small">{s.change && s.change.count === null ? <span className="muted">new</span> : <Delta value={s.change?.count} quiet />}</div>
              </td>
              <td>
                <Sparkline values={s.spark} />
              </td>
              <td className="num">
                {s.errors ? (
                  <span className="error-text">
                    {s.errors.toLocaleString('en-US')} ({formatPercent(s.errorRate)})
                  </span>
                ) : (
                  '0'
                )}
              </td>
              <td className="num">
                {approx && '≈ '}
                {formatDuration(s.p50)}
              </td>
              <td className="num">
                {approx && '≈ '}
                {formatDuration(s.p95)}
                <div className="small">
                  <Delta value={s.change?.p95} bad="up" quiet estimate={approx} />
                </div>
              </td>
              <td className="num">{formatDuration(s.max)}</td>
              <td className="num">{s.avgConstructorMs === null ? '–' : formatDuration(s.avgConstructorMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeriesTable({ data }: { data: DashboardData }) {
  return (
    <div style={{ maxHeight: 220, overflow: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th>From</th>
            <th className="num">Succeeded</th>
            <th className="num">Failed</th>
          </tr>
        </thead>
        <tbody>
          {data.series.map((b) => (
            <tr key={b.start}>
              <td>{formatShortDateTime(b.start)}</td>
              <td className="num">{(b.count - b.errors).toLocaleString('en-US')}</td>
              <td className="num">{b.errors.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 3 days, 5 h, 40 min. */
function formatSpan(ms: number): string {
  if (ms >= 2 * 86_400_000) return `${Math.round(ms / 86_400_000)} days`;
  if (ms >= 2 * 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

export function DashboardPage() {
  const { api } = useClient();
  const status = useStatus();
  const route = useRoute();
  const r = route.params.get('r') as DashboardRangeKey | null;
  const range: DashboardRangeKey = r && r in DASHBOARD_RANGE_LABELS ? r : '7d';
  const data = useAsync(() => api.dashboard(range), [range, status?.dataVersion]);
  const [seriesAsTable, setSeriesAsTable] = useState(false);
  const d = data.data;

  if (!d) {
    return (
      <main className="page">
        <div className="loading-screen">
          <Spinner />
        </div>
      </main>
    );
  }
  const k = d.kpis;
  const approx = d.source === 'rollups' ? '≈ ' : '';
  const bucketLabel = d.bucketMs >= 86_400_000 ? 'per day' : d.bucketMs >= 3_600_000 ? `per ${d.bucketMs / 3_600_000} h` : `per ${d.bucketMs / 60_000} min`;
  return (
    <main className="page">
      <div className="dashboard">
        <div className="row">
          <div className="section-title grow" style={{ margin: 0 }}>
            Dashboard
          </div>
          <Dropdown
            aria-label="Time range"
            value={DASHBOARD_RANGE_LABELS[range]}
            selectedOptions={[range]}
            onOptionSelect={(_, o) => navigate(href('dashboard', { r: o.optionValue }), true)}
            style={{ minWidth: 150 }}
          >
            {(Object.keys(DASHBOARD_RANGE_LABELS) as DashboardRangeKey[]).map((key) => (
              <Option key={key} value={key}>
                {DASHBOARD_RANGE_LABELS[key]}
              </Option>
            ))}
          </Dropdown>
        </div>
        {k.executions === 0 ? (
          <>
            <div className="card">
              <EmptyState title="No executions in this range">Pick a longer range, or wait for the next sync.</EmptyState>
            </div>
            {d.findings.length > 0 && (
              <div className="card card-pad">
                <h2>Findings</h2>
                {d.findings.map((f) => (
                  <FindingRow key={f.id} f={f} range={range} />
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Executions" value={compactCount(k.executions)} sub={DASHBOARD_RANGE_LABELS[range]} delta={<Delta value={d.change?.count} />} />
              <Tile label="Error rate" value={formatPercent(k.errorRate)} sub={`${k.errors.toLocaleString('en-US')} failed`} tone={k.errorRate > 0.05 ? 'critical' : undefined} delta={<Delta value={d.change?.errorRate} points bad="up" />} />
              <Tile label="p95 sync duration" value={`${approx}${formatDuration(k.p95SyncMs)}`} sub="Users wait for sync steps" delta={<Delta value={d.change?.p95} bad="up" estimate={d.source === 'rollups'} />} />
              <Tile label="Slowest step (p95)" value={k.slowestStep ? `${approx}${formatDuration(k.slowestStep.p95)}` : '–'} sub={k.slowestStep?.name} />
              <Tile label="Max depth" value={String(k.maxDepth)} sub={k.maxDepth >= 6 ? 'Possible update loop' : 'Nesting of plugin calls'} tone={k.maxDepth >= 6 ? 'critical' : undefined} />
              <Tile label="Data coverage" value={formatPercent(d.coverage)} sub={d.coverage >= 0.995 ? 'Collected the whole range' : `${formatSpan((1 - d.coverage) * (d.to - d.from))} not collected`} />
            </div>
            {(d.source === 'rollups' || d.change) && (
              <div className="small muted">
                {d.source === 'rollups' && 'Part of this range is older than the executions kept locally (30 days), so it comes from hourly summaries: percentiles (≈) are estimates, within 25 %. '}
                {d.change && `▲▼ compare with the previous ${DASHBOARD_RANGE_LABELS[range].replace(/^Last /, '')}, per hour of data collected.`}
              </div>
            )}
            <div className="dash-row">
              <div className="card card-pad">
                <div className="row" style={{ marginBottom: 6 }}>
                  <h2 className="grow" style={{ margin: 0 }}>
                    Executions {bucketLabel}
                  </h2>
                  <StackedLegend />
                  <Switch label="Table" checked={seriesAsTable} onChange={(_, s) => setSeriesAsTable(s.checked)} />
                </div>
                {seriesAsTable ? <SeriesTable data={d} /> : <StackedColumns buckets={d.series.map((b) => ({ start: b.start, end: b.start + d.bucketMs, ok: b.count - b.errors, errors: b.errors }))} gaps={d.gaps} height={200} label={`Executions ${bucketLabel}`} />}
                {d.gaps.length > 0 && <div className="small muted">Shaded periods: no data was collected (before local history starts, or the app wasn't opened for more than a day).</div>}
              </div>
              <div className="card card-pad">
                <div className="row" style={{ marginBottom: 6 }}>
                  <h2 className="grow" style={{ margin: 0 }}>
                    Findings
                  </h2>
                  <ThresholdsDialog />
                </div>
                {d.findings.length === 0 ? <div className="muted">Nothing stands out in this range.</div> : d.findings.map((f) => <FindingRow key={f.id} f={f} range={range} />)}
              </div>
            </div>
            <div className="card card-pad">
              <div className="row" style={{ marginBottom: 6 }}>
                <h2 className="grow" style={{ margin: 0 }}>
                  When things run (local time)
                </h2>
                <HeatmapScale max={d.heatmap.max} />
              </div>
              <Heatmap days={d.heatmap.days} counts={d.heatmap.counts} errors={d.heatmap.errors} max={d.heatmap.max} />
            </div>
            <div className="card card-pad">
              <h2>Steps</h2>
              <StepTable steps={d.steps} range={range} approx={d.source === 'rollups'} />
            </div>
          </>
        )}
        <div className="card card-pad">
          <h2>Platform statistics</h2>
          <PlatformPanel platform={d.platform} />
        </div>
      </div>
    </main>
  );
}
