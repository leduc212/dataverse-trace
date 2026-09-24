// Waterfall layout: turns a Trace into ordered rows with display times.
//
// With whole-second timestamps (spike S1) siblings in one pipeline often share the same start
// second. Durations are exact and execution order is known (stage, then rank), so the layout places
// siblings one after another inside their parent and marks those positions as estimated.
import type { Span, Trace } from './model.ts';

export interface WaterfallRow {
  span: Span;
  /** Nesting level in the tree (0 = root). */
  level: number;
  parentId: string | null;
  childIds: string[];
  displayStart: number;
  displayEnd: number;
  /** True when displayStart was moved from the recorded start to respect execution order. */
  estimated: boolean;
  /** Confidence of the link to the parent (1 = exact). */
  linkConfidence: number;
}

export interface WaterfallLayout {
  rows: WaterfallRow[];
  start: number;
  end: number;
}

const LANE_ORDER = { sync: 0, async: 1, flow: 2, audit: 3 } as const;
const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
const durationOf = (s: Span) => s.metrics.durationMs ?? (s.end !== undefined ? s.end - s.start : 0);

function siblingOrder(a: Span, b: Span): number {
  return (
    cmp(a.stage ?? 99, b.stage ?? 99) ||
    cmp(a.rank ?? 0, b.rank ?? 0) ||
    cmp(a.start, b.start) ||
    cmp(LANE_ORDER[a.lane], LANE_ORDER[b.lane]) ||
    cmp(a.id, b.id)
  );
}

export function layoutWaterfall(trace: Trace): WaterfallLayout {
  const byId = new Map(trace.spans.map((s) => [s.id, s]));
  const parentOf = new Map<string, { id: string; confidence: number }>();
  /** Child ids per parent; `sequential` children (childOf) run inside the parent, the rest (followsFrom) were only triggered by it. */
  const children = new Map<string, Array<{ id: string; sequential: boolean }>>();
  // Prefer childOf over followsFrom/triggeredBy when a span has both; keep the most confident link.
  const tree = trace.links
    .filter((l) => (l.type === 'childOf' || l.type === 'followsFrom' || l.type === 'triggeredBy') && byId.has(l.from) && byId.has(l.to))
    .sort((a, b) => cmp(a.type === 'childOf' ? 0 : 1, b.type === 'childOf' ? 0 : 1) || b.confidence - a.confidence);
  for (const l of tree) {
    if (parentOf.has(l.to) || l.from === l.to) continue;
    // Refuse links that would create a cycle.
    let cursor: string | undefined = l.from;
    let cycle = false;
    while (cursor) {
      if (cursor === l.to) {
        cycle = true;
        break;
      }
      cursor = parentOf.get(cursor)?.id;
    }
    if (cycle) continue;
    parentOf.set(l.to, { id: l.from, confidence: l.confidence });
    const entry = { id: l.to, sequential: l.type === 'childOf' };
    const list = children.get(l.from);
    if (list) list.push(entry);
    else children.set(l.from, [entry]);
  }

  const rows: WaterfallRow[] = [];
  const place = (span: Span, level: number, parentId: string | null, minStart: number) => {
    const estimated = span.precision === 's' && minStart > span.start;
    const displayStart = span.precision === 's' ? Math.max(span.start, minStart) : span.start;
    const row: WaterfallRow = {
      span,
      level,
      parentId,
      childIds: [],
      displayStart,
      displayEnd: displayStart + durationOf(span),
      estimated,
      linkConfidence: parentId ? (parentOf.get(span.id)?.confidence ?? 1) : 1,
    };
    rows.push(row);
    const entries = children.get(span.id) ?? [];
    /** childOf children run inside this span; the others were only triggered by it. */
    const containedIds = new Set(entries.filter((e) => e.sequential).map((e) => e.id));
    const kids = entries.map((e) => byId.get(e.id)!).sort(siblingOrder);
    row.childIds = kids.map((k) => k.id);
    // Inside a request, its steps run one after another, and the request lasts until the last one
    // ends. Spans it only triggered (e.g. a system job it queued) start on their own clock.
    let cursor = displayStart;
    let hasSequential = false;
    for (const kid of kids) {
      const sequential = span.kind === 'request' && containedIds.has(kid.id);
      // Contained children (childOf) can't start before their parent; triggered ones keep their own
      // start (a save is audited at commit, after the pipeline that it triggered has started).
      const kidRow = place(kid, level + 1, span.id, sequential ? cursor : containedIds.has(kid.id) ? displayStart : kid.start);
      if (sequential) {
        cursor = Math.max(cursor, kidRow.displayEnd);
        hasSequential = true;
      }
    }
    if (hasSequential) row.displayEnd = Math.max(row.displayStart, cursor);
    // With whole-second timestamps a parent can come out shorter than the work inside it
    // (a job started and completed "in the same second" but ran a 152 ms activity). Stretch it.
    if (span.precision === 's' && span.kind !== 'request') {
      for (const kid of rows.filter((r) => r.parentId === span.id && containedIds.has(r.span.id))) {
        if (kid.displayEnd > row.displayEnd) {
          row.displayEnd = kid.displayEnd;
          row.estimated = true;
        }
      }
    }
    return row;
  };

  const roots = trace.spans.filter((s) => !parentOf.has(s.id)).sort((a, b) => cmp(LANE_ORDER[a.lane], LANE_ORDER[b.lane]) || cmp(a.start, b.start) || cmp(a.id, b.id));
  for (const root of roots) place(root, 0, null, root.start);

  const start = Math.min(...rows.map((r) => Math.min(r.displayStart, r.span.queuedAt ?? r.displayStart)));
  const end = Math.max(...rows.map((r) => r.displayEnd));
  return { rows, start, end };
}

export interface CriticalSegment {
  spanId: string;
  /** Time on the path spent in this span itself (not in the children that are also on the path). */
  selfMs: number;
  /** Time on the path spent waiting before it started (a system job in the queue, a flow's delay). */
  queueMs: number;
}

export interface CriticalPath {
  /** Span ids on the path, from the root down. */
  spanIds: string[];
  /** Where the path's time went, by span, largest first. Adds up to {@link wallMs}. */
  segments: CriticalSegment[];
  /** Wall time the path explains: from the start of its root to the end of the whole trace. */
  wallMs: number;
}

/**
 * The critical path: the chain of spans that decided when the trace finished. Starting from the
 * root whose work ends last, it walks back in time, at each level taking the child that finished
 * last before the current point, then the one that finished before that child was started or
 * queued, and so on (the approach tracing tools such as Jaeger use). Save markers have no duration
 * and are skipped. Each span's share is its own time on the path, and queue time is kept apart,
 * so "7 s waiting for the async service" doesn't read as a slow plug-in.
 */
export function criticalPath(layout: WaterfallLayout): CriticalPath {
  const byId = new Map(layout.rows.map((r) => [r.span.id, r]));
  const subtreeEnd = new Map<string, number>();
  const endOf = (r: WaterfallRow): number => {
    const known = subtreeEnd.get(r.span.id);
    if (known !== undefined) return known;
    let end = r.displayEnd;
    for (const id of r.childIds) end = Math.max(end, endOf(byId.get(id)!));
    subtreeEnd.set(r.span.id, end);
    return end;
  };
  const roots = layout.rows.filter((r) => r.parentId === null && r.span.kind !== 'audit');
  if (roots.length === 0) return { spanIds: [], segments: [], wallMs: 0 };
  const root = roots.reduce((best, r) => (endOf(r) > endOf(best) ? r : best));
  const spanIds: string[] = [];
  const segments = new Map<string, CriticalSegment>();
  const segment = (id: string) => {
    let seg = segments.get(id);
    if (!seg) segments.set(id, (seg = { spanId: id, selfMs: 0, queueMs: 0 }));
    return seg;
  };
  /** Walks `row` backwards from `until`; returns when the row (or its queue wait) began. */
  const walk = (row: WaterfallRow, until: number): number => {
    spanIds.push(row.span.id);
    const seg = segment(row.span.id);
    let cursor = Math.min(until, endOf(row));
    const kids = row.childIds.map((id) => byId.get(id)!).filter((k) => k.span.kind !== 'audit');
    const used = new Set<string>();
    for (;;) {
      let next: WaterfallRow | undefined;
      let nextEnd = -Infinity;
      for (const k of kids) {
        if (used.has(k.span.id) || k.displayStart >= cursor) continue;
        const end = Math.min(endOf(k), cursor);
        if (end > nextEnd || (end === nextEnd && next && k.displayStart < next.displayStart)) {
          next = k;
          nextEnd = end;
        }
      }
      if (!next || nextEnd <= row.displayStart) break;
      used.add(next.span.id);
      seg.selfMs += cursor - nextEnd;
      cursor = walk(next, cursor);
      if (cursor <= row.displayStart) break;
    }
    seg.selfMs += Math.max(0, cursor - row.displayStart);
    // A queued span waited before it started: that wait is on the path too.
    const queuedAt = row.span.queuedAt;
    if (queuedAt !== undefined && queuedAt < row.displayStart && row !== root) {
      seg.queueMs += row.displayStart - queuedAt;
      return queuedAt;
    }
    return Math.min(cursor, row.displayStart);
  };
  walk(root, endOf(root));
  const list = [...segments.values()].filter((s) => s.selfMs + s.queueMs > 0).sort((a, b) => b.selfMs + b.queueMs - (a.selfMs + a.queueMs) || (a.spanId < b.spanId ? -1 : 1));
  return { spanIds, segments: list, wallMs: endOf(root) - root.displayStart };
}
