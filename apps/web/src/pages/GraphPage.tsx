// The observed cascade graph: which steps ran inside which, with loops highlighted. Left to right:
// a step, then the steps of the requests it caused. Built from the same links as the timeline.
import { edgeId, formatDuration, layoutCascade, type CascadeCycle, type CascadeEdge, type CascadeGraph, type CascadeLayout, type CascadeNode } from '@dvt/core';
import { Badge, Dropdown, Option, Spinner, Switch } from '@fluentui/react-components';
import { ArrowRepeatAllRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { EmptyState } from '../components/bits.tsx';
import { useAsync, useClient, useStatus } from '../client.ts';
import { shortTypeName, STAGE_LABELS } from '../format.ts';
import { href, navigate, useRoute } from '../router.ts';
import { RANGE_LABELS, type CascadeView, type RangeKey } from '../shared/api.ts';

const NODE_W = 210;
const NODE_H = 48;
/** Room around the drawing for loop arcs and labels. */
const PAD = { left: 16, top: 16, bottom: 70 };

const nodeLabel = (n: CascadeNode) => `${n.messageName} ${n.primaryEntity ?? ''} · ${n.mode}`;

/** Forward edges leave and enter at 40 % of the node height; edges going back use 75 %, so a pair A→B, B→A doesn't overlap. */
const FORWARD_Y = NODE_H * 0.4;
const BACK_Y = NODE_H * 0.75;

interface Point {
  x: number;
  y: number;
  layer: number;
}

function edgePath(a: Point, b: Point, back: boolean, self: boolean, floor: number): { d: string; label: { x: number; y: number } } {
  if (self) {
    const x = a.x + NODE_W;
    const y = a.y + NODE_H / 2;
    return { d: `M ${x} ${y - 10} C ${x + 45} ${y - 40}, ${x + 45} ${y + 40}, ${x} ${y + 10}`, label: { x: x + 36, y: y - 20 } };
  }
  if (back && a.layer === b.layer + 1) {
    // One layer back: from the left side of the source to the right side of the target, in the lower lane.
    const x1 = a.x;
    const y1 = a.y + BACK_Y;
    const x2 = b.x + NODE_W + 6;
    const y2 = b.y + BACK_Y;
    const mid = (x1 + x2) / 2;
    return { d: `M ${x1} ${y1} C ${mid} ${y1 + 14}, ${mid} ${y2 + 14}, ${x2} ${y2}`, label: { x: mid, y: (y1 + y2) / 2 + 20 } };
  }
  if (back) {
    // Further back (or within a layer): below every node, so it never hides behind one.
    const x1 = a.x + NODE_W / 2;
    const x2 = b.x + NODE_W / 2;
    return { d: `M ${x1} ${a.y + NODE_H} C ${x1} ${floor}, ${x2} ${floor}, ${x2} ${b.y + NODE_H + 6}`, label: { x: (x1 + x2) / 2, y: floor - 4 } };
  }
  const x1 = a.x + NODE_W;
  const y1 = a.y + FORWARD_Y;
  const x2 = b.x - 6;
  const y2 = b.y + FORWARD_Y;
  const mid = (x1 + x2) / 2;
  return { d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`, label: { x: mid, y: (y1 + y2) / 2 - 6 } };
}

function Graph({ graph, layout, selected, cycleKeys, onSelect }: { graph: CascadeGraph; layout: CascadeLayout; selected: string | null; cycleKeys: Set<string>; onSelect: (key: string) => void }) {
  const pos = new Map([...layout.nodes.values()].map((n): [string, Point] => [n.key, { x: n.x + PAD.left, y: n.y + PAD.top, layer: n.layer }]));
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  const inCycle = (e: CascadeEdge) => cycleKeys.has(e.from) && cycleKeys.has(e.to);
  const floor = layout.height + PAD.top + 30;
  const width = layout.width - (260 - NODE_W) + PAD.left + 60;
  const height = layout.height + PAD.top + PAD.bottom;
  return (
    <svg className="cascade" width={width} height={height} role="img" aria-label={`Cascade graph: ${graph.nodes.length} steps, ${graph.edges.length} links`}>
      <defs>
        <marker id="cascade-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--viz-axis)" />
        </marker>
        <marker id="cascade-arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--viz-critical)" />
        </marker>
      </defs>
      {graph.edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const loop = inCycle(e);
        const { d, label } = edgePath(a, b, layout.backEdges.has(edgeId(e)), e.from === e.to, floor);
        const faded = selected !== null && e.from !== selected && e.to !== selected;
        return (
          <g key={edgeId(e)} className={`cascade-edge${loop ? ' loop' : ''}${faded ? ' faded' : ''}`}>
            <path d={d} fill="none" strokeDasharray={e.ambiguous === e.count ? '5 4' : undefined} markerEnd={`url(#cascade-arrow${loop ? '-loop' : ''})`}>
              <title>{`${byKey.get(e.from)?.typeName} → ${byKey.get(e.to)?.typeName}: ${e.count} times, p95 ${formatDuration(e.p95Ms)}${e.ambiguous ? ` (${e.ambiguous} with more than one possible parent)` : ''}`}</title>
            </path>
            <text x={label.x} y={label.y} textAnchor="middle">
              ×{e.count.toLocaleString('en-US')}
            </text>
          </g>
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos.get(n.key);
        if (!p) return null;
        const cls = `cascade-node${cycleKeys.has(n.key) ? ' loop' : ''}${selected === n.key ? ' selected' : ''}`;
        return (
          <g
            key={n.key}
            className={cls}
            transform={`translate(${p.x} ${p.y})`}
            role="button"
            tabIndex={0}
            aria-label={`${n.typeName}, ${nodeLabel(n)}, ${n.runs} runs in cascades`}
            aria-pressed={selected === n.key}
            onClick={() => onSelect(n.key)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onSelect(n.key);
              }
            }}
          >
            <rect width={NODE_W} height={NODE_H} rx={6} />
            <text x={10} y={20} className="name">
              {shortTypeName(n.typeName).slice(0, 26)}
            </text>
            <text x={10} y={37} className="sub">
              {nodeLabel(n).slice(0, 32)}
            </text>
            <title>{n.typeName}</title>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Hides links where every observation had more than one possible parent (R3 closest fit), and the
 * steps left without links. Loops keep all their links: a loop is never hidden.
 */
function certainOnly(graph: CascadeGraph): CascadeGraph {
  const loopNodes = new Set(graph.cycles.flatMap((c) => c.nodes));
  const edges = graph.edges.filter((e) => e.ambiguous < e.count || (loopNodes.has(e.from) && loopNodes.has(e.to)));
  const keep = new Set(edges.flatMap((e) => [e.from, e.to]));
  return { ...graph, edges, nodes: graph.nodes.filter((n) => keep.has(n.key)) };
}

function EdgeTable({ view }: { view: CascadeView }) {
  const byKey = new Map(view.graph.nodes.map((n) => [n.key, n]));
  return (
    <div style={{ overflow: 'auto' }}>
      <table className="data" aria-label="Cascade links">
        <thead>
          <tr>
            <th>Step</th>
            <th>Caused</th>
            <th className="num">Times</th>
            <th className="num">p95 of the caused step</th>
          </tr>
        </thead>
        <tbody>
          {view.graph.edges.map((e) => (
            <tr key={edgeId(e)}>
              <td>{byKey.get(e.from)?.typeName}</td>
              <td>
                {byKey.get(e.to)?.typeName} <span className="small muted">{byKey.get(e.to) && nodeLabel(byKey.get(e.to)!)}</span>
              </td>
              <td className="num">{e.count.toLocaleString('en-US')}</td>
              <td className="num">{formatDuration(e.p95Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CycleCard({ cycle, view, onSelect }: { cycle: CascadeCycle; view: CascadeView; onSelect: (key: string) => void }) {
  const byKey = new Map(view.graph.nodes.map((n) => [n.key, n]));
  return (
    <div className="cycle">
      <div className="row" style={{ gap: 6 }}>
        <ArrowRepeatAllRegular className="error-text" aria-hidden="true" />
        <strong>{cycle.nodes.length === 1 ? 'A step that triggers itself' : `A loop between ${cycle.nodes.length} steps`}</strong>
      </div>
      <ul>
        {cycle.nodes.map((k) => (
          <li key={k}>
            <button className="link" onClick={() => onSelect(k)}>
              {byKey.get(k)?.typeName ?? k}
            </button>{' '}
            <span className="small muted">{byKey.get(k) && nodeLabel(byKey.get(k)!)}</span>
          </li>
        ))}
      </ul>
      <div className="small muted">
        {cycle.operations.toLocaleString('en-US')} {cycle.operations === 1 ? 'operation' : 'operations'} went all the way round.
      </div>
      {cycle.examples.length > 0 && (
        <div className="small">
          Operations with the whole loop:{' '}
          {cycle.examples.map((c, i) => (
            <span key={c}>
              {i > 0 && ', '}
              <a href={href('trace', {}, c)}>{c.slice(0, 8)}</a>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function NodeDetail({ node, view }: { node: CascadeNode; view: CascadeView }) {
  const byKey = new Map(view.graph.nodes.map((n) => [n.key, n]));
  const causes = view.graph.edges.filter((e) => e.from === node.key && e.to !== node.key);
  const causedBy = view.graph.edges.filter((e) => e.to === node.key && e.from !== node.key);
  const self = view.graph.edges.find((e) => e.from === node.key && e.to === node.key);
  const reg = node.stepId ? view.steps[node.stepId] : undefined;
  const list = (edges: CascadeEdge[], other: (e: CascadeEdge) => string) => (
    <ul>
      {edges.map((e) => (
        <li key={edgeId(e)}>
          {byKey.get(other(e))?.typeName} <span className="small muted">×{e.count.toLocaleString('en-US')} · p95 {formatDuration(e.p95Ms)}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div>
      <div className="title" style={{ fontWeight: 600, wordBreak: 'break-all' }}>
        {node.typeName}
      </div>
      <div className="small muted">
        {nodeLabel(node)}
        {reg ? ` · ${STAGE_LABELS[reg.stage] ?? reg.stage}` : ''}
        {reg && reg.filteringAttributes === null && node.messageName === 'Update' ? ' · no filtering attributes' : ''}
      </div>
      <div className="small" style={{ margin: '6px 0' }}>
        {node.runs.toLocaleString('en-US')} runs in cascades, up to depth {node.maxDepth}.
        {self && ` It ran inside itself ${self.count.toLocaleString('en-US')} times.`}
      </div>
      {causes.length > 0 && (
        <>
          <div className="section-title">Causes</div>
          {list(causes, (e) => e.to)}
        </>
      )}
      {causedBy.length > 0 && (
        <>
          <div className="section-title">Caused by</div>
          {list(causedBy, (e) => e.from)}
        </>
      )}
      <button className="link small" onClick={() => navigate(href('explorer', { q: node.stepId ? `step:${node.stepId}` : `type:"${node.typeName}"`, v: 'executions' }))}>
        Show its executions →
      </button>
    </div>
  );
}

export function GraphPage() {
  const { api } = useClient();
  const status = useStatus();
  const route = useRoute();
  const r = route.params.get('r') as RangeKey | null;
  const range: RangeKey = r && r in RANGE_LABELS ? r : '7d';
  const table = route.params.get('t');
  const selected = route.params.get('n');
  const [asTable, setAsTable] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const data = useAsync(() => api.cascade(range, table), [range, table, status?.dataVersion]);
  const full = data.data;
  const view = useMemo(() => (full && !uncertain ? { ...full, graph: certainOnly(full.graph) } : full), [full, uncertain]);
  const hidden = full && view ? full.graph.edges.length - view.graph.edges.length : 0;
  const layout = useMemo(() => (view ? layoutCascade(view.graph) : null), [view]);
  const cycleKeys = useMemo(() => new Set(view?.graph.cycles.flatMap((c) => c.nodes) ?? []), [view]);
  const go = (next: { r?: string; t?: string | null; n?: string | null }) =>
    navigate(href('graph', { r: next.r ?? (range === '7d' ? undefined : range), t: (next.t === undefined ? table : next.t) ?? undefined, n: (next.n === undefined ? selected : next.n) ?? undefined }), true);

  const selectedNode = view?.graph.nodes.find((n) => n.key === selected) ?? null;
  return (
    <main className="page">
      <div className="dashboard">
        <div className="row">
          <div className="section-title grow" style={{ margin: 0 }}>
            Cascades
          </div>
          <Dropdown aria-label="Table" value={table ?? 'All tables'} selectedOptions={[table ?? '']} onOptionSelect={(_, o) => go({ t: o.optionValue || null, n: null })} style={{ minWidth: 160 }}>
            <Option value="">All tables</Option>
            {(view?.tables ?? []).map((t) => (
              <Option key={t} value={t}>
                {t}
              </Option>
            ))}
          </Dropdown>
          <Dropdown aria-label="Time range" value={RANGE_LABELS[range]} selectedOptions={[range]} onOptionSelect={(_, o) => go({ r: o.optionValue ?? '7d' })} style={{ minWidth: 150 }}>
            {(Object.keys(RANGE_LABELS) as RangeKey[]).map((key) => (
              <Option key={key} value={key}>
                {RANGE_LABELS[key]}
              </Option>
            ))}
          </Dropdown>
        </div>
        {!view ? (
          <div className="loading-screen">
            <Spinner />
          </div>
        ) : view.graph.nodes.length === 0 ? (
          <div className="card">
            <EmptyState title="No cascades in this range">A cascade is a plug-in whose own requests (an update it makes, say) run other steps one depth deeper. None were seen here.</EmptyState>
          </div>
        ) : (
          <div className="graph-layout">
            <div className="card card-pad">
              <div className="row" style={{ marginBottom: 6 }}>
                <div className="grow small muted">
                  {view.graph.nodes.length} steps, {view.graph.edges.length} links, from {view.graph.operations.toLocaleString('en-US')} operations with nested requests. Left to right: a step, then what its requests ran.
                  {uncertain ? ' Dashed: every time, more than one step could have been the parent.' : hidden > 0 ? ` ${hidden} uncertain ${hidden === 1 ? 'link is' : 'links are'} hidden (more than one step could have been the parent every time).` : ''}
                </div>
                <Switch label="Uncertain links" checked={uncertain} onChange={(_, d) => setUncertain(d.checked)} />
                <Switch label="Table" checked={asTable} onChange={(_, d) => setAsTable(d.checked)} />
              </div>
              {asTable ? (
                <EdgeTable view={view} />
              ) : (
                <div className="graph-scroll">
                  <Graph graph={view.graph} layout={layout!} selected={selected} cycleKeys={cycleKeys} onSelect={(key) => go({ n: key === selected ? null : key })} />
                </div>
              )}
            </div>
            <div className="card card-pad graph-side">
              {view.graph.cycles.length > 0 && (
                <>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <h2 className="grow" style={{ margin: 0 }}>
                      Loops
                    </h2>
                    <Badge appearance="filled" color="danger">
                      {view.graph.cycles.length}
                    </Badge>
                  </div>
                  {view.graph.cycles.map((c) => (
                    <CycleCard key={c.nodes.join('+')} cycle={c} view={view} onSelect={(key) => go({ n: key })} />
                  ))}
                </>
              )}
              {selectedNode ? (
                <NodeDetail node={selectedNode} view={view} />
              ) : (
                <div className="small muted" style={{ marginTop: view.graph.cycles.length ? 12 : 0 }}>
                  {view.graph.cycles.length === 0 && 'No loops in this range. '}Select a step to see what it causes and what causes it.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
