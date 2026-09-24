// The timeline: one row per span, bars on a shared time axis. Used by the trace page, the record
// story, watch mode and imported sessions.
import { criticalPath, formatDuration, type Span, type Trace, type WaterfallLayout, type WaterfallRow } from '@dvt/core';
import { Badge, Button, Menu, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, ToggleButton, Tooltip } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular, DismissRegular, ErrorCircleFilled, FlashRegular, ZoomFitRegular, ZoomInRegular, ZoomOutRegular } from '@fluentui/react-icons';
import { useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useClient } from '../client.ts';
import { STAGE_LABELS, formatTime, shortTypeName } from '../format.ts';
import { recordUrl } from '../host.ts';
import { ExecutionPanel } from '../pages/DetailPanels.tsx';
import { href } from '../router.ts';
import { KeyValues } from './bits.tsx';
import { TraceText } from './TraceText.tsx';

/** What the timeline draws: a trace and its layout. */
export interface TimelineData {
  trace: Trace;
  layout: WaterfallLayout;
}

export type BarClass = 'request' | 'sync' | 'async' | 'activity' | 'flow' | 'save';

export function barClass(span: Span): BarClass {
  if (span.kind === 'audit') return 'save';
  if (span.kind === 'request') return 'request';
  if (span.kind === 'flowRun') return 'flow';
  if (span.kind === 'workflowActivity') return 'activity';
  if (span.kind === 'systemJob' || span.mode === 'async') return 'async';
  return 'sync';
}

export const KIND_LABEL: Record<BarClass, string> = {
  request: 'Request',
  sync: 'Sync plugin',
  async: 'Async',
  activity: 'Workflow activity',
  flow: 'Cloud flow',
  save: 'Save',
};

const KIND_COLOR: Record<BarClass, string> = {
  request: 'var(--viz-request)',
  sync: 'var(--viz-series-1)',
  async: 'var(--viz-series-3)',
  activity: 'var(--viz-series-2)',
  flow: 'var(--viz-series-2)',
  save: 'var(--colorNeutralForeground1)',
};

export function spanLabel(span: Span): string {
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

export const offsetLabel = (ms: number) => (ms === 0 ? '0' : `+${formatDuration(ms)}`);

/**
 * Plugin durations are exact (milliseconds from the platform). System-job and flow durations come
 * from whole-second timestamps, so under a second we can only say "< 1 s".
 */
export function durationLabel(r: WaterfallRow): string {
  const span = r.span;
  if (span.kind === 'audit') return 'saved';
  if ((span.kind === 'systemJob' || span.kind === 'flowRun') && span.precision === 's') {
    if (span.end === undefined) return 'running';
    const measured = span.metrics.durationMs ?? 0;
    return measured < 1000 ? '< 1 s' : span.kind === 'flowRun' ? formatDuration(measured) : `≈ ${formatDuration(measured)}`;
  }
  return formatDuration(r.displayEnd - r.displayStart);
}

const confidenceLabel = (c: number) => (c >= 1 ? 'exact' : `${Math.round(c * 100)} %`);

export function traceMarkdown(view: TimelineData, subtitle?: string): string {
  const { trace, layout } = view;
  const lines = [
    `### ${trace.summary.title} · ${formatDuration(trace.summary.wallMs)} · ${trace.summary.errors} error(s)`,
    '',
    subtitle ?? `Correlation ID: \`${trace.key}\`${trace.anchor ? ` · Record: ${trace.anchor.table} ${trace.anchor.name ?? trace.anchor.id}` : ''}`,
    '',
    '| Span | Kind | Start | Duration | Link | Status |',
    '|---|---|---|---|---|---|',
    ...layout.rows.map(
      (r) =>
        `| ${'  '.repeat(r.level)}${spanLabel(r.span).replace(/\|/g, '\\|')} | ${KIND_LABEL[barClass(r.span)]} | ${offsetLabel(r.displayStart - layout.start)}${r.estimated ? ' ≈' : ''} | ${durationLabel(r)} | ${r.linkConfidence < 1 ? `inferred ${confidenceLabel(r.linkConfidence)}` : ''} | ${r.span.status}${r.span.error ? `: ${r.span.error.message.split('\n')[0]!.replace(/\|/g, '\\|')}` : ''} |`,
    ),
  ];
  if (trace.caveats.length) lines.push('', ...trace.caveats.map((c) => `> ${c.message}`));
  return lines.join('\n');
}

/** Link filters: every link, links of at least 50 % confidence, or exact links only. */
type LinkFilter = 'all' | 'likely' | 'exact';
const LINK_MIN: Record<LinkFilter, number> = { all: 0, likely: 0.5, exact: 1 };
const LINK_LABELS: Record<LinkFilter, string> = { all: 'All links', likely: 'Links ≥ 50 %', exact: 'Exact links only' };

/**
 * An overview of the whole trace with the zoomed window marked. Drag across it to zoom to that
 * part; click to move the window there.
 */
function Minimap({ layout, zoom, onZoom }: { layout: WaterfallLayout; zoom: [number, number] | null; onZoom: (z: [number, number] | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const start = layout.start;
  const span = Math.max(layout.end - start, 1);
  const at = (clientX: number) => {
    const box = ref.current!.getBoundingClientRect();
    return start + (Math.min(Math.max(clientX - box.left, 0), box.width) / box.width) * span;
  };
  const x = (t: number) => `${((t - start) / span) * 100}%`;
  const rows = layout.rows.filter((r) => r.span.kind !== 'audit');
  const rowH = Math.max(1, Math.min(3, 30 / Math.max(rows.length, 1)));
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const [a, b] = [Math.min(drag[0], at(e.clientX)), Math.max(drag[0], at(e.clientX))];
    setDrag(null);
    const box = ref.current!.getBoundingClientRect();
    if (((b - a) / span) * box.width >= 4) {
      onZoom(a <= start && b >= layout.end ? null : [a, b]);
    } else if (zoom) {
      // A click: keep the zoom width, centred where clicked.
      const half = (zoom[1] - zoom[0]) / 2;
      const mid = Math.min(Math.max(a, start + half), layout.end - half);
      onZoom([mid - half, mid + half]);
    }
  };
  return (
    <div
      ref={ref}
      className="wf-minimap"
      aria-hidden="true"
      title="Drag across to zoom, click to move the zoomed window"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const t = at(e.clientX);
        setDrag([t, t]);
      }}
      onPointerMove={(e) => drag && setDrag([drag[0], at(e.clientX)])}
      onPointerUp={finish}
    >
      {rows.map((r, i) => (
        <span
          key={r.span.id}
          className="wf-minimap-bar"
          style={{ left: x(r.displayStart), width: `max(1px, ${((r.displayEnd - r.displayStart) / span) * 100}%)`, top: 3 + i * rowH, height: rowH, background: KIND_COLOR[barClass(r.span)] }}
        />
      ))}
      {zoom && <span className="wf-minimap-window" style={{ left: x(zoom[0]), width: `${((zoom[1] - zoom[0]) / span) * 100}%` }} />}
      {drag && <span className="wf-minimap-drag" style={{ left: x(Math.min(...drag)), width: `${(Math.abs(drag[1] - drag[0]) / span) * 100}%` }} />}
    </div>
  );
}

/** Where the critical path's time went: the biggest shares, queue waits listed on their own. */
function CriticalSummary({ layout, path, onSelect }: { layout: WaterfallLayout; path: ReturnType<typeof criticalPath>; onSelect: (id: string) => void }) {
  const byId = new Map(layout.rows.map((r) => [r.span.id, r]));
  const parts = path.segments
    .flatMap((s) => [
      { id: s.spanId, ms: s.selfMs, queue: false },
      { id: s.spanId, ms: s.queueMs, queue: true },
    ])
    .filter((p) => p.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4);
  return (
    <div className="small wf-critical" role="status">
      <strong>Critical path, {formatDuration(path.wallMs)}:</strong>{' '}
      {parts.map((p, i) => {
        const row = byId.get(p.id);
        const name = row ? spanLabel(row.span) : p.id;
        return (
          <span key={`${p.id}${p.queue}`}>
            {i > 0 && ' · '}
            <button className="link" onClick={() => onSelect(p.id)}>
              {name}
            </button>{' '}
            {p.queue ? `waited ${formatDuration(p.ms)}${row?.span.kind === 'flowRun' ? ' to start' : ' in the queue'}` : formatDuration(p.ms)}
            <span className="muted"> ({Math.round((p.ms / Math.max(path.wallMs, 1)) * 100)} %)</span>
          </span>
        );
      })}
    </div>
  );
}

export function Waterfall({ view, selected, onSelect }: { view: TimelineData; selected: string | null; onSelect: (id: string) => void }) {
  const { layout } = view;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [depthLimit, setDepthLimit] = useState<number | null>(null);
  const [links, setLinks] = useState<LinkFilter>('all');
  const [showCritical, setShowCritical] = useState(false);
  const critical = useMemo(() => criticalPath(layout), [layout]);
  const onPath = useMemo(() => new Set(critical.spanIds), [critical]);
  const maxDepth = layout.rows.reduce((m, r) => Math.max(m, r.span.depth ?? 0), 0);

  const { visible, filteredOut } = useMemo(() => {
    const byId = new Map(layout.rows.map((r) => [r.span.id, r]));
    const min = LINK_MIN[links];
    const weak = (r: WaterfallRow) => r.parentId !== null && r.linkConfidence < min;
    const hidden = (r: WaterfallRow): boolean => {
      if (weak(r)) return true;
      let p = r.parentId;
      while (p) {
        if (collapsed.has(p)) return true;
        const parent = byId.get(p);
        if (parent && weak(parent)) return true;
        p = parent?.parentId ?? null;
      }
      return false;
    };
    const rows = layout.rows.filter((r) => !hidden(r));
    // Rows hidden by the link filter (not by collapsing), for the note under the toolbar.
    const byLinks = min > 0 ? layout.rows.filter((r) => {
      for (let cur: WaterfallRow | undefined = r; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) if (weak(cur)) return true;
      return false;
    }).length : 0;
    return { visible: rows, filteredOut: byLinks };
  }, [layout, collapsed, links]);

  /** Collapses every row whose children run deeper than `depth` (Dataverse depth, not tree level). */
  const collapseToDepth = (depth: number | null) => {
    setDepthLimit(depth);
    if (depth === null) {
      setCollapsed(new Set());
      return;
    }
    const byId = new Map(layout.rows.map((r) => [r.span.id, r]));
    setCollapsed(new Set(layout.rows.filter((r) => r.childIds.some((id) => (byId.get(id)?.span.depth ?? 0) > depth)).map((r) => r.span.id)));
  };

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
  const syncRows = layout.rows.filter((r) => r.span.lane === 'sync' || r.span.lane === 'audit');
  const syncRange: [number, number] | null = syncRows.length
    ? [Math.min(...syncRows.map((r) => r.displayStart)), Math.max(...syncRows.map((r) => r.displayEnd))]
    : null;
  const hasAsync = layout.rows.some((r) => r.span.lane !== 'sync' && r.span.lane !== 'audit');
  const kinds = new Set(layout.rows.map((r) => barClass(r.span)));
  const hasInferred = layout.rows.some((r) => r.linkConfidence < 1);
  const dim = showCritical && critical.spanIds.length > 0;
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
        <Button size="small" appearance="subtle" onClick={() => collapseToDepth(null)}>
          Expand all
        </Button>
        {maxDepth > 1 && (
          <Menu checkedValues={{ depth: [depthLimit === null ? 'all' : String(depthLimit)] }} onCheckedValueChange={(_, d) => collapseToDepth(d.checkedItems[0] === 'all' ? null : Number(d.checkedItems[0]))}>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<ChevronDownRegular />} iconPosition="after">
                {depthLimit === null ? 'All depths' : `Down to depth ${depthLimit}`}
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItemRadio name="depth" value="all">
                  All depths
                </MenuItemRadio>
                {Array.from({ length: maxDepth - 1 }, (_, i) => i + 1).map((d) => (
                  <MenuItemRadio key={d} name="depth" value={String(d)}>
                    Collapse below depth {d}
                  </MenuItemRadio>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
        {hasInferred && (
          <Menu checkedValues={{ links: [links] }} onCheckedValueChange={(_, d) => setLinks(d.checkedItems[0] as LinkFilter)}>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<ChevronDownRegular />} iconPosition="after">
                {LINK_LABELS[links]}
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {(Object.keys(LINK_LABELS) as LinkFilter[]).map((k) => (
                  <MenuItemRadio key={k} name="links" value={k}>
                    {k === 'all' ? 'Show all links' : k === 'likely' ? 'Hide inferred links under 50 %' : 'Hide every inferred link'}
                  </MenuItemRadio>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
        {critical.spanIds.length > 1 && (
          <Tooltip content="The chain of spans that decided when this finished: at each point, whatever finished last before it. Everything else is dimmed." relationship="description">
            <ToggleButton size="small" appearance="subtle" icon={<FlashRegular />} checked={showCritical} onClick={() => setShowCritical((v) => !v)}>
              Critical path
            </ToggleButton>
          </Tooltip>
        )}
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
      {dim && <CriticalSummary layout={layout} path={critical} onSelect={onSelect} />}
      {layout.rows.length > 3 && <Minimap layout={layout} zoom={zoom} onZoom={setZoom} />}
      {filteredOut > 0 && (
        <div className="small muted" style={{ padding: '2px 8px' }}>
          {filteredOut} {filteredOut === 1 ? 'row is' : 'rows are'} hidden by the link filter.{' '}
          <button className="link" onClick={() => setLinks('all')}>
            Show all
          </button>
        </div>
      )}
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
            const inferred = r.linkConfidence < 1;
            const tip = [
              `${span.name}`,
              `${KIND_LABEL[cls]}${span.stage ? ` · ${STAGE_LABELS[span.stage] ?? span.stage}` : ''}${span.depth !== undefined ? ` · depth ${span.depth}` : ''}`,
              `Starts ${offsetLabel(r.displayStart - layout.start)}${r.estimated ? ' (position estimated: timestamps are whole seconds)' : ''}`,
              cls === 'save' ? '' : `Duration ${durationLabel(r)}`,
              queued ? `${cls === 'flow' ? 'Started' : 'Queued'} ${formatDuration(r.displayStart - span.queuedAt!)} ${cls === 'flow' ? 'after the save' : 'before starting'}` : '',
              span.error ? `Error: ${span.error.message}` : '',
              inferred ? `Link is inferred (${Math.round(r.linkConfidence * 100)} % confidence): select the row to see why` : '',
            ]
              .filter(Boolean)
              .join('\n');
            return (
              <div key={span.id} style={{ display: 'contents' }} onClick={() => onSelect(span.id)} onDoubleClick={() => setZoom([r.span.queuedAt ?? r.displayStart, Math.max(r.displayEnd, r.displayStart + 1)])}>
                <div
                  className={`wf-label${isSel ? ' selected' : ''}${dim && !onPath.has(span.id) ? ' dimmed' : ''}`}
                  style={{ paddingLeft: 6 + r.level * 16 }}
                  role="row"
                  aria-level={r.level + 1}
                  aria-selected={isSel}
                  aria-description={dim && onPath.has(span.id) ? 'on the critical path' : undefined}
                >
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
                  <span className={`wf-kind${cls === 'save' ? ' diamond' : ''}`} style={{ background: KIND_COLOR[cls] }} />
                  <span className="ellipsis grow" title={span.name}>
                    {span.kind === 'request' || cls === 'save' ? <b>{spanLabel(span)}</b> : spanLabel(span)}
                    {span.stage && span.kind !== 'request' ? <span className="muted"> · {STAGE_LABELS[span.stage]?.replace('-operation', '-op')}</span> : null}
                  </span>
                  {inferred && (
                    <Badge size="small" appearance="outline" color="warning" title="Inferred link: select the row to see the evidence">
                      ≈{Math.round(r.linkConfidence * 100)}%
                    </Badge>
                  )}
                  {span.status === 'error' && <ErrorCircleFilled className="error-text" fontSize={14} aria-label="Failed" />}
                  {span.status === 'waiting' && <Badge size="small" appearance="tint">waiting</Badge>}
                  {span.status === 'running' && <Badge size="small" appearance="tint" color="brand">running</Badge>}
                </div>
                <div className={`wf-lane${isSel ? ' selected' : ''}${dim ? (onPath.has(span.id) ? ' critical' : ' dimmed') : ''}`} title={tip}>
                  {ticks.map((t) => (
                    <span key={t} className="wf-gridline" style={{ left: `${pct(layout.start + t)}%` }} />
                  ))}
                  {queued && <span className={`wf-queue${cls === 'flow' ? ' delay' : ''}`} style={{ left: `${pct(span.queuedAt!)}%`, width: `${Math.max(left - pct(span.queuedAt!), 0.15)}%` }} />}
                  {cls === 'save' ? (
                    <span className="wf-save" style={{ left: `${left}%` }} />
                  ) : (
                    <span className={`wf-bar ${cls}${span.status === 'error' ? ' error' : ''}${r.estimated ? ' estimated' : ''}${inferred ? ' inferred' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
                  )}
                  {cls !== 'request' && (
                    <span className="wf-bar-label" style={left + width < 82 ? { left: `calc(${left + width}% + ${cls === 'save' ? 10 : 6}px)` } : { right: `calc(${100 - left}% + 6px)` }}>
                      {cls === 'save' ? formatTime(span.start) : durationLabel(r)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="wf-legend" aria-label="Legend">
        {kinds.has('save') && (
          <span className="key">
            <span className="wf-kind diamond" style={{ background: KIND_COLOR.save }} /> Save (from audit)
          </span>
        )}
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-series-1)' }} /> Sync plugin (in the transaction)
        </span>
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-series-3)' }} /> Async (system job or async plugin)
        </span>
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-series-2)' }} /> {kinds.has('flow') ? 'Cloud flow or workflow activity' : 'Workflow activity'}
        </span>
        <span className="key">
          <span className="sw" style={{ background: 'var(--viz-request)', height: 4 }} /> Request (message pipeline)
        </span>
        <span className="key">
          <span className="sw wf-queue" style={{ position: 'static', display: 'inline-block' }} /> Waiting (queue, or delay before a flow started)
        </span>
        {hasInferred && (
          <span className="key">
            <span className="sw wf-bar inferred" style={{ position: 'static', display: 'inline-block', background: 'var(--viz-series-2)' }} /> Inferred link (≈ confidence)
          </span>
        )}
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

export function SpanTable({ view, onSelect }: { view: TimelineData; onSelect: (id: string) => void }) {
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
            <th>Link</th>
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
              <td>{r.linkConfidence < 1 ? `inferred ${confidenceLabel(r.linkConfidence)}` : ''}</td>
              <td>{r.span.error ? <span className="error-text">{r.span.error.message}</span> : r.span.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function spanKindText(span: Span): string {
  switch (span.kind) {
    case 'request':
      return 'Message pipeline (all steps of one request)';
    case 'flowRun':
      return 'Cloud flow run';
    case 'audit':
      return 'Save of the record (from audit history)';
    case 'systemJob':
      return 'System job';
    default:
      return KIND_LABEL[barClass(span)];
  }
}

/**
 * Details of one span, with the evidence behind its links. `offline` (imported sessions) shows
 * what the file contains instead of reading local history.
 */
export function SpanPanel({ view, spanId, onClose, offline = false, texts }: { view: TimelineData; spanId: string; onClose: () => void; offline?: boolean; texts?: Record<string, string> }) {
  const { host } = useClient();
  const span = view.trace.spans.find((s) => s.id === spanId);
  if (!span) return null;
  if (!offline && span.source?.table === 'plugintracelog') return <ExecutionPanel id={span.source.id} search="" onClose={onClose} inTimeline />;
  const links = view.trace.links.filter((l) => l.to === span.id || l.from === span.id);
  const name = (id: string) => view.trace.spans.find((s) => s.id === id)?.name ?? id;
  const record = span.record;
  const recordLink = record && !offline ? recordUrl(host, record.table, record.id) : null;
  const text = texts?.[span.id];
  return (
    <>
      <div className="detail-head">
        <div className="row">
          <div className="detail-title grow">{span.name}</div>
          <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label="Close" onClick={onClose} />
        </div>
        <div className="small muted">{spanKindText(span)}</div>
      </div>
      <div className="detail-body">
        <KeyValues
          items={[
            ['Kind', KIND_LABEL[barClass(span)]],
            ['Status', span.status + (span.attrs['job.status'] ? ` (${span.attrs['job.status']})` : span.attrs['flow.status'] ? ` (${span.attrs['flow.status']})` : '')],
            [span.kind === 'audit' ? 'Saved' : 'Started', formatTime(span.start)],
            ['Duration', span.kind === 'audit' ? null : span.end === undefined ? 'still running' : formatDuration(span.metrics.durationMs)],
            ['Changed columns', span.attrs['save.columns'] ? String(span.attrs['save.columns']) : null],
            ['Queue time', span.metrics.queueMs !== undefined ? formatDuration(span.metrics.queueMs) : null],
            ['Retries', span.metrics.retries ? String(span.metrics.retries) : null],
            ['Run', span.attrs['flow.run'] ? <span className="mono">{String(span.attrs['flow.run'])}</span> : null],
            ['Trigger', span.attrs['flow.trigger'] ? String(span.attrs['flow.trigger']) : null],
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
            ['Record story', record && !offline && span.kind !== 'audit' ? <a className="link" href={href('record', {}, `${record.table}/${record.id}`)}>Open the record's saves</a> : null],
            ['Request ID', span.requestId ? <span className="mono">{span.requestId}</span> : null],
            ['Error', span.error ? <span className="error-text">{span.error.message}</span> : null],
          ].filter(([, v]) => v !== null && v !== undefined) as Array<[string, ReactNode]>}
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
                      <span className="muted"> · rule {l.rule}</span>
                      <ul className="evidence">
                        {l.evidence.map((e, j) => (
                          <li key={j} className={e.weight < 0 ? 'against' : e.weight === 0 ? 'neutral' : ''}>
                            {e.label}
                            {e.weight !== 0 && l.confidence < 1 ? <span className="muted"> ({e.weight > 0 ? '+' : ''}{Math.round(e.weight * 100)})</span> : null}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="num small">
                      <Badge size="small" appearance={l.confidence < 1 ? 'outline' : 'tint'} color={l.confidence < 1 ? 'warning' : 'success'}>
                        {confidenceLabel(l.confidence)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {text && (
          <>
            <div className="section-title" style={{ marginTop: 16 }}>
              Trace text
            </div>
            <TraceText text={text} />
          </>
        )}
      </div>
    </>
  );
}
