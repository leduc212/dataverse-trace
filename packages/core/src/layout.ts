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
  // Prefer childOf over followsFrom when a span has both; keep the most confident link.
  const tree = trace.links
    .filter((l) => (l.type === 'childOf' || l.type === 'followsFrom') && byId.has(l.from) && byId.has(l.to))
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
    const sequentialIds = new Set(entries.filter((e) => e.sequential).map((e) => e.id));
    const kids = entries.map((e) => byId.get(e.id)!).sort(siblingOrder);
    row.childIds = kids.map((k) => k.id);
    // Inside a request, its steps run one after another, and the request lasts until the last one
    // ends. Spans it only triggered (e.g. a system job it queued) start on their own clock.
    let cursor = displayStart;
    let hasSequential = false;
    for (const kid of kids) {
      const sequential = span.kind === 'request' && sequentialIds.has(kid.id);
      const kidRow = place(kid, level + 1, span.id, sequential ? cursor : displayStart);
      if (sequential) {
        cursor = Math.max(cursor, kidRow.displayEnd);
        hasSequential = true;
      }
    }
    if (hasSequential) row.displayEnd = Math.max(row.displayStart, cursor);
    // With whole-second timestamps a parent can come out shorter than the work inside it
    // (a job started and completed "in the same second" but ran a 152 ms activity). Stretch it.
    if (span.precision === 's' && span.kind !== 'request') {
      for (const kid of rows.filter((r) => r.parentId === span.id && sequentialIds.has(r.span.id))) {
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
