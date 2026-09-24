import { formatDuration, type Span, type WaterfallRow } from '@dvt/core';
import { Badge, Button, MessageBar, MessageBarBody, Spinner, Switch, Tooltip } from '@fluentui/react-components';
import {
  ArrowLeftRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  CopyRegular,
  DismissRegular,
  ErrorCircleFilled,
  ZoomFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
} from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { EmptyState, KeyValues } from '../components/bits.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { STAGE_LABELS, formatTime, shortTypeName } from '../format.ts';
import { recordUrl } from '../host.ts';
import { href, navigate } from '../router.ts';
import type { TraceView } from '../shared/api.ts';
import { ExecutionPanel } from './DetailPanels.tsx';

type BarClass = 'request' | 'sync' | 'async' | 'activity';

function barClass(span: Span): BarClass {
  if (span.kind === 'request') return 'request';
  if (span.kind === 'workflowActivity') return 'activity';
  if (span.kind === 'systemJob' || span.mode === 'async') return 'async';
  return 'sync';
}

const KIND_LABEL: Record<BarClass, string> = { request: 'Request', sync: 'Sync plugin', async: 'Async', activity: 'Workflow activity' };

function spanLabel(span: Span): string {
  if (span.kind === 'plugin' || span.kind === 'workflowActivity') return shortTypeName(span.name);
  return span.name;
}

/** Clean tick spacing: 1-2-5 steps from 1 ms up to hours. */
function tickStep(spanMs: number, target = 7): number {
  const raw = spanMs / target;
  const exp = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

const offsetLabel = (ms: number) => (ms === 0 ? '0' : `+${formatDuration(ms)}`);

/**
 * Plugin durations are exact (milliseconds from the platform). System-job durations come from
 * whole-second timestamps, so under a second we can only say "< 1 s".
 */
function durationLabel(r: WaterfallRow): string {
  const span = r.span;
  if (span.kind === 'systemJob' && span.precision === 's') {
    const measured = span.metrics.durationMs ?? 0;
    return measured < 1000 ? '< 1 s' : `≈ ${formatDuration(measured)}`;
  }
  return formatDuration(r.displayEnd - r.displayStart);
}

function traceMarkdown(view: TraceView): string {
  const { trace, layout } = view;
  const lines = [
    `### ${trace.summary.title} · ${formatDuration(trace.summary.wallMs)} · ${trace.summary.errors} error(s)`,
    '',
    `Correlation ID: \`${trace.key}\`${trace.anchor ? ` · Record: ${trace.anchor.table} ${trace.anchor.name ?? trace.anchor.id}` : ''}`,
    '',
    '| Span | Kind | Start | Duration | Status |',
    '|---|---|---|---|---|',
    ...layout.rows.map(
      (r) =>
        `| ${'  '.repeat(r.level)}${spanLabel(r.span)} | ${KIND_LABEL[barClass(r.span)]} | ${offsetLabel(r.displayStart - layout.start)}${r.estimated ? ' ≈' : ''} | ${durationLabel(r)} | ${r.span.status}${r.span.error ? `: ${r.span.error.message}` : ''} |`,
    ),
  ];
  return lines.join('\n');
}

function Waterfall({ view, selected, onSelect }: { view: TraceView; selected: string | null; onSelect: (id: string) => void }) {
  const { layout } = view;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<[number, number] | null>(null);

  const visible = useMemo(() => {
    const byId = new Map(layout.rows.map((r) => [r.span.id, r]));
    const hidden = (r: WaterfallRow): boolean => {
      let p = r.parentId;
      while (p) {
        if (collapsed.has(p)) return true;
        p = byId.get(p)?.parentId ?? null;
      }
      return false;
    };
    return layout.rows.filter((r) => !hidden(r));
  }, [layout, collapsed]);

  const full: [number, number] = [layout.start, Math.max(layout.end, layout.start + 1)];
  const [d0, d1] = zoom ?? full;
  const pad = (d1 - d0) * 0.02;
  const domainStart = d0 - pad;
  const domainSpan = d1 - d0 + 2 * pad;
  const pct = (t: number) => ((t - domainStart) / domainSpan) * 100;
  const step = tickStep(d1 - d0);
  const ticks: number[] = [];
  for (let t = Math.ceil((d0 - layout.start) / step) * step; layout.start + t <= d1; t += step) ticks.push(t);

  const zoomBy = (factor: number) => {
    const mid = (d0 + d1) / 2;
    const half = Math.max(((d1 - d0) / 2) * factor, 1);
    const next: [number, number] = [Math.max(full[0], mid - half), Math.min(full[1], mid + half)];
    setZoom(next[0] <= full[0] && next[1] >= full[1] ? null : next);
  };
  const syncRows = layout.rows.filter((r) => r.span.lane === 'sync');
  const syncRange: [number, number] | null = syncRows.length
    ? [Math.min(...syncRows.map((r) => r.displayStart)), Math.max(...syncRows.map((r) => r.displayEnd))]
    : null;
  const hasAsync = layout.rows.some((r) => r.span.lane !== 'sync');
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="card waterfall">
      <div className="row" style={{ padding: '6px 8px', borderBottom: '1px solid var(--colorNeutralStroke2)' }}>
        <Button size="small" appearance="subtle" onClick={() => setCollapsed(new Set())}>
          Expand all
        </Button>
        <Button size="small" appearance="subtle" onClick={() => setCollapsed(new Set(layout.rows.filter((r) => r.level >= 1 && r.childIds.length).map((r) => r.span.id)))}>
          Collapse nested
        </Button>
        <div className="grow" />
        {syncRange && hasAsync && (
          <Tooltip content="Zoom to the synchronous part: what the user waited for when saving" relationship="description">
            <Button size="small" appearance="subtle" onClick={() => setZoom([syncRange[0], Math.max(syncRange[1], syncRange[0] + 1)])}>
              Zoom to save
            </Button>
          </Tooltip>
        )}
        <Tooltip content="Zoom in" relationship="label">
          <Button size="small" appearance="subtle" icon={<ZoomInRegular />} onClick={() => zoomBy(0.5)} />
        </Tooltip>
        <Tooltip content="Zoom out" relationship="label">
          <Button size="small" appearance="subtle" icon={<ZoomOutRegular />} disabled={!zoom} onClick={() => zoomBy(2)} />
        </Tooltip>
        <Tooltip content="Fit (or double-click a row to zoom to it)" relationship="label">
          <Button size="small" appearance="subtle" icon={<ZoomFitRegular />} disabled={!zoom} onClick={() => setZoom(null)} />
        </Tooltip>
      </div>
      <div className="wf-scroll">
        <div className="wf-grid" role="treegrid" aria-label="Execution timeline">
          <div className="wf-axis labels">Span</div>
          <div className="wf-axis" style={{ position: 'sticky' }}>
            {ticks.map((t) => (
              <span key={t} className="tick-label" style={{ left: `${pct(layout.start + t)}%` }}>
                {offsetLabel(t)}
              </span>
            ))}
          </div>
          {visible.map((r) => {
            const span = r.span;
            const cls = barClass(span);
            const isSel = selected === span.id;
            const left = pct(r.displayStart);
            const width = Math.max(pct(r.displayEnd) - left, 0.15);
            const queued = span.queuedAt !== undefined && span.queuedAt < r.displayStart;
            const tip = [
              `${span.name}`,
              `${KIND_LABEL[cls]}${span.stage ? ` · ${STAGE_LABELS[span.stage] ?? span.stage}` : ''}${span.depth !== undefined ? ` · depth ${span.depth}` : ''}`,
              `Starts ${offsetLabel(r.displayStart - layout.start)}${r.estimated ? ' (position estimated: timestamps are whole seconds)' : ''}`,
              `Duration ${durationLabel(r)}`,
              queued ? `Queued ${formatDuration(r.displayStart - span.queuedAt!)} before starting` : '',
              span.error ? `Error: ${span.error.message}` : '',
              r.linkConfidence < 1 ? `Parent is uncertain (${Math.round(r.linkConfidence * 100)} % confidence)` : '',
            ]
              .filter(Boolean)
              .join('\n');
            return (
              <div key={span.id} style={{ display: 'contents' }} onClick={() => onSelect(span.id)} onDoubleClick={() => setZoom([r.span.queuedAt ?? r.displayStart, Math.max(r.displayEnd, r.displayStart + 1)])}>
                <div className={`wf-label${isSel ? ' selected' : ''}`} style={{ paddingLeft: 6 + r.level * 16 }} role="row" aria-level={r.level + 1} aria-selected={isSel}>
                  {r.childIds.length ? (
                    <button
                      className="wf-toggle"
                      aria-label={collapsed.has(span.id) ? 'Expand' : 'Collapse'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(span.id);
                      }}
                    >
                      {collapsed.has(span.id) ? <ChevronRightRegular /> : <ChevronDownRegular />}
                    </button>
                  ) : (
                    <span className="wf-toggle" />
                  )}
                  <span className="wf-kind" style={{ background: `var(${cls === 'request' ? '--viz-request' : cls === 'sync' ? '--viz-series-1' : cls === 'async' ? '--viz-series-3' : '--viz-series-2'})` }} />
                  <span className="ellipsis grow" title={span.name}>
                    {span.kind === 'request' ? <b>{spanLabel(span)}</b> : spanLabel(span)}
                    {span.stage && span.kind !== 'request' ? <span className="muted"> · {STAGE_LABELS[span.stage]?.replace('-operation', '-op')}</span> : null}
                  </span>
                  {r.linkConfidence < 1 && (
                    <Badge size="small" appearance="outline" color="warning" title="The parent of this span is uncertain">
                      ≈{Math.round(r.linkConfidence * 100)}%
                    </Badge>
                  )}
                  {span.status === 'error' && <ErrorCircleFilled className="error-text" fontSize={14} aria-label="Failed" />}
                  {span.status === 'waiting' && <Badge size="small" appearance="tint">waiting</Badge>}
                  {span.status === 'running' && <Badge size="small" appearance="tint" color="brand">running</Badge>}
                </div>
                <div className={`wf-lane${isSel ? ' selected' : ''}`} title={tip}>
                  {ticks.map((t) => (
                    <span key={t} className="wf-gridline" style={{ left: `${pct(layout.start + t)}%` }} />
                  ))}
                  {queued && <span className="wf-queue" style={{ left: `${pct(span.queuedAt!)}%`, width: `${Math.max(left - pct(span.queuedAt!), 0.15)}%` }} />}
                  <span className={`wf-bar ${cls}${span.status === 'error' ? ' error' : ''}${r.estimated ? ' estimated' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
                  {cls !== 'request' && (
                    <span className="wf-bar-label" style={left + width < 82 ? { left: `calc(${left + width}% + 6px)` } : { right: `calc(${100 - left}% + 6px)` }}>
                      {durationLabel(r)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="wf-legend" aria-label="Legend">
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-series-1)' }} /> Sync plugin (in the transaction)
        </span>
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-series-3)' }} /> Async (system job or async plugin)
        </span>
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-series-2)' }} /> Workflow activity
        </span>
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-request)', height: 4 }} /> Request (message pipeline)
        </span>
        <span className="key">
          <span className="sw wf-queue" style={{ position: 'static', display: 'inline-block' }} /> Waiting in the queue
        </span>
        <span className="key">
          <ErrorCircleFilled className="error-text" fontSize={12} /> Failed
        </span>
        <span className="key">
          <span className="sw" style={{ borderLeft: '1px dotted var(--colorNeutralForeground2)', width: 6, borderRadius: 0 }} /> Start estimated (whole-second timestamps; durations are exact)
        </span>
      </div>
    </div>
  );
}

function SpanTable({ view, onSelect }: { view: TraceView; onSelect: (id: string) => void }) {
  const { layout } = view;
  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <table className="data">
        <thead>
          <tr>
            <th>Span</th>
            <th>Kind</th>
            <th className="num">Starts</th>
            <th className="num">Duration</th>
            <th className="num">Depth</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {layout.rows.map((r) => (
            <tr key={r.span.id} style={{ cursor: 'pointer' }} onClick={() => onSelect(r.span.id)}>
              <td style={{ paddingLeft: 8 + r.level * 16 }}>{spanLabel(r.span)}</td>
              <td>{KIND_LABEL[barClass(r.span)]}</td>
              <td className="num">
                {r.estimated ? '≈ ' : ''}
                {offsetLabel(r.displayStart - layout.start)}
              </td>
              <td className="num">{durationLabel(r)}</td>
              <td className="num">{r.span.depth ?? '–'}</td>
              <td>{r.span.error ? <span className="error-text">{r.span.error.message}</span> : r.span.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpanPanel({ view, spanId, onClose }: { view: TraceView; spanId: string; onClose: () => void }) {
  const { host } = useClient();
  const span = view.trace.spans.find((s) => s.id === spanId);
  if (!span) return null;
  if (span.source?.table === 'plugintracelog') return <ExecutionPanel id={span.source.id} search="" onClose={onClose} inTimeline />;
  const links = view.trace.links.filter((l) => l.to === span.id || l.from === span.id);
  const name = (id: string) => view.trace.spans.find((s) => s.id === id)?.name ?? id;
  const record = span.record;
  const recordLink = record ? recordUrl(host, record.table, record.id) : null;
  return (
    <>
      <div className="detail-head">
        <div className="row">
          <div className="detail-title grow">{span.name}</div>
          <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label="Close" onClick={onClose} />
        </div>
        <div className="small muted">{span.kind === 'request' ? 'Message pipeline (all steps of one request)' : 'System job'}</div>
      </div>
      <div className="detail-body">
        <KeyValues
          items={[
            ['Kind', span.kind === 'request' ? 'Request' : 'System job'],
            ['Status', span.status + (span.attrs['job.status'] ? ` (${span.attrs['job.status']})` : '')],
            ['Started', formatTime(span.start)],
            ['Duration', formatDuration(span.metrics.durationMs)],
            ['Queue time', span.metrics.queueMs !== undefined ? formatDuration(span.metrics.queueMs) : null],
            ['Retries', span.metrics.retries ? String(span.metrics.retries) : null],
            ['Message', span.message],
            ['Table', span.table],
            ['Depth', span.depth],
            [
              'Record',
              record ? (
                recordLink ? (
                  <a className="link" href={recordLink} target="_blank" rel="noreferrer">
                    {record.name ?? record.id} ({record.table})
                  </a>
                ) : (
                  `${record.name ?? record.id} (${record.table})`
                )
              ) : null,
            ],
            ['Request ID', span.requestId ? <span className="mono">{span.requestId}</span> : null],
            ['Error', span.error ? <span className="error-text">{span.error.message}</span> : null],
          ]}
        />
        {links.length > 0 && (
          <>
            <div className="section-title" style={{ marginTop: 16 }}>
              Why these links
            </div>
            <table className="data">
              <tbody>
                {links.map((l, i) => (
                  <tr key={i}>
                    <td className="small">
                      {l.from === span.id ? `→ ${name(l.to)}` : `← ${name(l.from)}`}
                      <div className="muted">{l.evidence.map((e) => e.label).join('; ')}</div>
                    </td>
                    <td className="num small">{l.confidence === 1 ? 'exact' : `${Math.round(l.confidence * 100)} %`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}

export function TracePage({ correlationId }: { correlationId: string }) {
  const { api, host } = useClient();
  const status = useStatus();
  const view = useAsync(() => api.trace(correlationId), [correlationId, status?.dataVersion]);
  const [selected, setSelected] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);
  const v = view.data;

  if (!v) {
    return (
      <main className="page">
        {view.loading ? (
          <div className="loading-screen">
            <Spinner />
          </div>
        ) : (
          <div className="card">
            <EmptyState title="Trace not found">
              No executions with correlation ID <span className="mono">{correlationId}</span> are in local history.
            </EmptyState>
          </div>
        )}
      </main>
    );
  }
  const s = v.trace.summary;
  const anchor = v.trace.anchor;
  const anchorLink = anchor ? recordUrl(host, anchor.table, anchor.id) : null;
  return (
    <main className="page fill">
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <Button size="small" appearance="subtle" icon={<ArrowLeftRegular />} onClick={() => history.back()}>
            Back
          </Button>
          <div className="section-title grow" style={{ margin: 0 }}>
            {s.title}
          </div>
          <Switch label="Table view" checked={asTable} onChange={(_, d) => setAsTable(d.checked)} />
          <Tooltip content="Copy as Markdown (for a bug report)" relationship="label">
            <Button size="small" icon={<CopyRegular />} onClick={() => void navigator.clipboard.writeText(traceMarkdown(v))}>
              Markdown
            </Button>
          </Tooltip>
        </div>
        <div className="trace-summary">
          <span className="stat">
            <span className="label">Started</span>
            <span className="value">{formatTime(s.start)}</span>
          </span>
          <span className="stat">
            <span className="label">End to end</span>
            <span className="value">{formatDuration(s.wallMs)}</span>
          </span>
          <span className="stat">
            <span className="label">In the save (sync)</span>
            <span className="value">{formatDuration(s.syncMs)}</span>
          </span>
          <span className="stat">
            <span className="label">Plugins</span>
            <span className="value">{(s.counts.plugin ?? 0) + (s.counts.workflowActivity ?? 0)}</span>
          </span>
          <span className="stat">
            <span className="label">System jobs</span>
            <span className="value">{s.counts.systemJob ?? 0}</span>
          </span>
          <span className="stat">
            <span className="label">Max depth</span>
            <span className="value">{s.maxDepth}</span>
          </span>
          <span className="stat">
            <span className="label">Errors</span>
            <span className={`value${s.errors ? ' error-text' : ''}`}>{s.errors}</span>
          </span>
          {anchor && (
            <span className="stat">
              <span className="label">Record</span>
              {anchorLink ? (
                <a className="link value" href={anchorLink} target="_blank" rel="noreferrer">
                  {anchor.name ?? anchor.id} ({anchor.table})
                </a>
              ) : (
                <span className="value">
                  {anchor.name ?? anchor.id} ({anchor.table})
                </span>
              )}
            </span>
          )}
          <span className="stat">
            <span className="label">Correlation</span>
            <button className="link mono" title="Filter the explorer by this correlation" onClick={() => navigate(href('explorer', { q: `corr:${correlationId}`, v: 'executions', r: 'all' }))}>
              {correlationId}
            </button>
          </span>
        </div>
        {v.trace.caveats.map((c) => (
          <MessageBar key={c.code} intent="info" style={{ marginTop: 8 }}>
            <MessageBarBody>{c.message}</MessageBarBody>
          </MessageBar>
        ))}
      </div>
      <div className={`trace-layout${selected ? ' with-detail' : ''}`}>
        {asTable ? <SpanTable view={v} onSelect={setSelected} /> : <Waterfall view={v} selected={selected} onSelect={setSelected} />}
        {selected && (
          <div className="card detail">
            <SpanPanel view={v} spanId={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>
    </main>
  );
}
