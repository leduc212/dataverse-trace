import { formatDuration, formatPercent } from '@dvt/core';
import { Dropdown, Option, Spinner, Switch } from '@fluentui/react-components';
import { ErrorCircleFilled, InfoRegular, WarningFilled } from '@fluentui/react-icons';
import { useState } from 'react';
import { EmptyState } from '../components/bits.tsx';
import { Heatmap, HeatmapScale, Sparkline, StackedColumns, StackedLegend } from '../components/charts.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { compactCount, formatShortDateTime, STAGE_LABELS } from '../format.ts';
import { href, navigate, useRoute } from '../router.ts';
import { RANGE_LABELS, type DashboardData, type DashboardStep, type Finding, type RangeKey } from '../shared/api.ts';

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'critical' }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value${tone === 'critical' ? ' error-text' : ''}`}>{value}</div>
      {sub && <div className="sub ellipsis" title={sub}>{sub}</div>}
    </div>
  );
}

function FindingRow({ f, range }: { f: Finding; range: RangeKey }) {
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
        {f.query && (
          <button className="link small" onClick={() => navigate(href('explorer', { q: f.query, r: range === '24h' ? undefined : range, v: 'executions' }))}>
            Show the executions →
          </button>
        )}
      </div>
    </div>
  );
}

type SortKey = 'count' | 'errors' | 'p50' | 'p95' | 'max' | 'avgConstructorMs';

function StepTable({ steps, range }: { steps: DashboardStep[]; range: RangeKey }) {
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
              onClick={() => navigate(href('explorer', { q: s.stepId ? `step:${s.stepId}` : `type:"${s.typeName}"`, r: range === '24h' ? undefined : range, v: 'executions' }))}
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
              <td className="num">{s.count.toLocaleString('en-US')}</td>
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
              <td className="num">{formatDuration(s.p50)}</td>
              <td className="num">{formatDuration(s.p95)}</td>
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

export function DashboardPage() {
  const { api } = useClient();
  const status = useStatus();
  const route = useRoute();
  const r = route.params.get('r') as RangeKey | null;
  const range: RangeKey = r && r in RANGE_LABELS ? r : '7d';
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
            value={RANGE_LABELS[range]}
            selectedOptions={[range]}
            onOptionSelect={(_, o) => navigate(href('dashboard', { r: o.optionValue }), true)}
            style={{ minWidth: 150 }}
          >
            {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
              <Option key={key} value={key}>
                {RANGE_LABELS[key]}
              </Option>
            ))}
          </Dropdown>
        </div>
        {k.executions === 0 ? (
          <div className="card">
            <EmptyState title="No executions in this range">Pick a longer range, or wait for the next sync.</EmptyState>
          </div>
        ) : (
          <>
            <div className="tiles">
              <Tile label="Executions" value={compactCount(k.executions)} sub={RANGE_LABELS[range]} />
              <Tile label="Error rate" value={formatPercent(k.errorRate)} sub={`${k.errors.toLocaleString('en-US')} failed`} tone={k.errorRate > 0.05 ? 'critical' : undefined} />
              <Tile label="p95 sync duration" value={formatDuration(k.p95SyncMs)} sub="Users wait for sync steps" />
              <Tile label="Slowest step (p95)" value={k.slowestStep ? formatDuration(k.slowestStep.p95) : '–'} sub={k.slowestStep?.name} />
              <Tile label="Max depth" value={String(k.maxDepth)} sub={k.maxDepth >= 6 ? 'Possible update loop' : 'Nesting of plugin calls'} tone={k.maxDepth >= 6 ? 'critical' : undefined} />
            </div>
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
                {d.gaps.length > 0 && <div className="small muted">Shaded periods: no data was collected (the app wasn't syncing for more than a day).</div>}
              </div>
              <div className="card card-pad">
                <h2>Findings</h2>
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
              <StepTable steps={d.steps} range={range} />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
