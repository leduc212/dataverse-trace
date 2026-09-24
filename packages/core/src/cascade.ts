// The observed cascade graph: which steps ran inside which. Nodes are steps (plug-ins and custom
// workflow activities); an edge A → B means a request that B handled ran inside an execution of A
// (rule R3 of the correlation, one depth deeper, in the same operation). Cycles are loops that
// really happened. Built from assembled traces, so it uses exactly the links the timeline draws.
import { quantileSorted } from './histogram.ts';
import type { Span, Trace } from './model.ts';
import type { ExecutionMode, TraceLogRecord } from './records.ts';
import { stepKeyOf } from './stats.ts';

export interface CascadeNode {
  key: string;
  stepId: string | null;
  typeName: string;
  messageName: string;
  primaryEntity: string | null;
  mode: ExecutionMode;
  /** Executions of this step that took part in a cascade (as parent or child). */
  runs: number;
  maxDepth: number;
}

export interface CascadeEdge {
  from: string;
  to: string;
  /** Times B ran inside A. */
  count: number;
  /** Of those, how many had more than one possible parent (R3 closest fit). */
  ambiguous: number;
  /** p95 duration of B's executions on this edge. */
  p95Ms: number;
  /** A few operations (correlation ids) where it happened. */
  examples: string[];
}

export interface CascadeCycle {
  /** Step keys in the cycle, in a stable order. */
  nodes: string[];
  /** Operations where every edge of the cycle was seen (up to 5). */
  examples: string[];
  /** How many operations went all the way round. */
  operations: number;
}

export interface CascadeGraph {
  nodes: CascadeNode[];
  edges: CascadeEdge[];
  cycles: CascadeCycle[];
  /** Operations with at least one nested request. */
  operations: number;
}

const MAX_EXAMPLES = 5;

/**
 * Builds the graph from assembled traces. `logsById` gives the trace rows behind the spans, so
 * nodes use the same step keys as the dashboard.
 */
export function buildCascade(traces: Iterable<Trace>, logsById: ReadonlyMap<string, TraceLogRecord>): CascadeGraph {
  const nodes = new Map<string, CascadeNode>();
  const edges = new Map<string, CascadeEdge & { durations: number[] }>();
  const edgeOps = new Map<string, Set<string>>();
  let operations = 0;
  const node = (log: TraceLogRecord, counted: Set<string>): string => {
    const key = stepKeyOf(log);
    let n = nodes.get(key);
    if (!n) {
      n = { key, stepId: log.stepId, typeName: log.typeName, messageName: log.messageName, primaryEntity: log.primaryEntity, mode: log.mode, runs: 0, maxDepth: 0 };
      nodes.set(key, n);
    }
    if (!counted.has(log.id)) {
      counted.add(log.id);
      n.runs++;
      n.maxDepth = Math.max(n.maxDepth, log.depth);
    }
    return key;
  };
  for (const trace of traces) {
    const spans = new Map<string, Span>(trace.spans.map((s) => [s.id, s]));
    const members = new Map<string, string[]>();
    for (const l of trace.links) {
      if (l.rule !== 'R2') continue;
      const list = members.get(l.from);
      if (list) list.push(l.to);
      else members.set(l.from, [l.to]);
    }
    const counted = new Set<string>();
    let nested = false;
    for (const link of trace.links) {
      if (link.rule !== 'R3') continue;
      const parentSpan = spans.get(link.from);
      const parentLog = parentSpan?.source ? logsById.get(parentSpan.source.id) : undefined;
      if (!parentLog) continue;
      nested = true;
      const from = node(parentLog, counted);
      for (const childId of members.get(link.to) ?? []) {
        const childSpan = spans.get(childId);
        const childLog = childSpan?.source ? logsById.get(childSpan.source.id) : undefined;
        if (!childLog) continue;
        const to = node(childLog, counted);
        const id = edgeId({ from, to });
        let e = edges.get(id);
        if (!e) edges.set(id, (e = { from, to, count: 0, ambiguous: 0, p95Ms: 0, examples: [], durations: [] }));
        e.count++;
        if (link.confidence < 1) e.ambiguous++;
        e.durations.push(childLog.durationMs);
        if (e.examples.length < MAX_EXAMPLES && !e.examples.includes(trace.key)) e.examples.push(trace.key);
        let ops = edgeOps.get(id);
        if (!ops) edgeOps.set(id, (ops = new Set()));
        ops.add(trace.key);
      }
    }
    if (nested) operations++;
  }
  const edgeList: CascadeEdge[] = [...edges.values()]
    .map(({ durations, ...e }) => ({ ...e, p95Ms: quantileSorted(durations.sort((a, b) => a - b), 0.95) ?? 0 }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const nodeList = [...nodes.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  const cycles = findCycles(
    nodeList.map((n) => n.key),
    edgeList,
  ).map((keys): CascadeCycle => {
    const inCycle = new Set(keys);
    const cycleEdges = edgeList.filter((e) => inCycle.has(e.from) && inCycle.has(e.to));
    // Operations where the whole loop was seen: every edge of it.
    let common: string[] | null = null;
    for (const e of cycleEdges) {
      const ops = edgeOps.get(edgeId(e))!;
      common = common === null ? [...ops] : common.filter((o) => ops.has(o));
    }
    const all = (common ?? []).sort();
    return { nodes: keys, examples: all.slice(0, MAX_EXAMPLES), operations: all.length };
  });
  return { nodes: nodeList, edges: edgeList, cycles, operations };
}

/** Strongly connected components with more than one node, or with a self-loop (Tarjan). Keys sorted within each. */
export function findCycles(keys: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): string[][] {
  const next = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of edges) next.get(e.from)?.push(e.to);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  // Iterative, so deep graphs can't overflow the call stack.
  for (const root of keys) {
    if (index.has(root)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const targets = next.get(frame.v) ?? [];
      if (frame.i < targets.length) {
        const w = targets[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
      if (low.get(frame.v) === index.get(frame.v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.v);
        const selfLoop = component.length === 1 && (next.get(frame.v) ?? []).includes(frame.v);
        if (component.length > 1 || selfLoop) out.push(component.sort());
      }
    }
  }
  return out.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

export interface LaidOutNode {
  key: string;
  layer: number;
  /** Position within the layer (0 = top). */
  order: number;
  x: number;
  y: number;
}

export interface CascadeLayout {
  nodes: Map<string, LaidOutNode>;
  /** Edges that point back to the same or an earlier layer (they close a cycle). */
  backEdges: Set<string>;
  width: number;
  height: number;
}

export const edgeId = (e: { from: string; to: string }) => `${e.from}→${e.to}`;

/**
 * A small layered layout, left to right: cycles are broken by reversing back edges found by a
 * depth-first search, layers come from the longest path, and a few barycentre sweeps reduce
 * crossings. Enough for the tens of steps a cascade has, without a layout library.
 */
export function layoutCascade(graph: Pick<CascadeGraph, 'nodes' | 'edges'>, size: { colWidth: number; rowHeight: number } = { colWidth: 260, rowHeight: 72 }): CascadeLayout {
  const keys = graph.nodes.map((n) => n.key);
  const out = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of graph.edges) out.get(e.from)?.push(e.to);
  // Back edges: DFS in key order, from nodes without parents first, so roots stay on the left.
  const indegree = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const e of graph.edges) if (e.from !== e.to) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const roots = [...keys].sort((a, b) => indegree.get(a)! - indegree.get(b)! || (a < b ? -1 : 1));
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  for (const root of roots) {
    if (state.has(root)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    state.set(root, 1);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const targets = out.get(frame.v)!;
      if (frame.i < targets.length) {
        const w = targets[frame.i++]!;
        const s = state.get(w);
        if (s === 1) back.add(edgeId({ from: frame.v, to: w }));
        else if (s === undefined) {
          state.set(w, 1);
          work.push({ v: w, i: 0 });
        }
        continue;
      }
      state.set(frame.v, 2);
      work.pop();
    }
  }
  const forward = graph.edges.filter((e) => !back.has(edgeId(e)) && e.from !== e.to);
  // Longest-path layering over the acyclic forward edges (Kahn order).
  const layer = new Map<string, number>(keys.map((k) => [k, 0]));
  const incoming = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const e of forward) incoming.set(e.to, incoming.get(e.to)! + 1);
  const queue = keys.filter((k) => incoming.get(k) === 0);
  while (queue.length) {
    const v = queue.shift()!;
    for (const e of forward) {
      if (e.from !== v) continue;
      layer.set(e.to, Math.max(layer.get(e.to)!, layer.get(v)! + 1));
      incoming.set(e.to, incoming.get(e.to)! - 1);
      if (incoming.get(e.to) === 0) queue.push(e.to);
    }
  }
  const layers: string[][] = [];
  for (const k of keys) (layers[layer.get(k)!] ??= []).push(k);
  for (const l of layers) l?.sort();
  // Barycentre sweeps: order each layer by the average position of its neighbours in the previous one.
  const position = () => new Map(layers.flatMap((l) => (l ?? []).map((k, i): [string, number] => [k, i])));
  for (let sweep = 0; sweep < 4; sweep++) {
    const pos = position();
    const down = sweep % 2 === 0;
    for (let li = down ? 1 : layers.length - 2; down ? li < layers.length : li >= 0; li += down ? 1 : -1) {
      const l = layers[li];
      if (!l) continue;
      const neighbours = (k: string) => forward.filter((e) => (down ? e.to === k && layer.get(e.from) === li - 1 : e.from === k && layer.get(e.to) === li + 1)).map((e) => pos.get(down ? e.from : e.to)!);
      const score = new Map(l.map((k) => {
        const n = neighbours(k);
        return [k, n.length ? n.reduce((a, b) => a + b, 0) / n.length : pos.get(k)!] as const;
      }));
      l.sort((a, b) => score.get(a)! - score.get(b)! || (a < b ? -1 : 1));
    }
  }
  const tallest = Math.max(1, ...layers.map((l) => l?.length ?? 0));
  const nodes = new Map<string, LaidOutNode>();
  layers.forEach((l, li) => {
    const offset = ((tallest - (l?.length ?? 0)) * size.rowHeight) / 2;
    (l ?? []).forEach((key, order) => nodes.set(key, { key, layer: li, order, x: li * size.colWidth, y: offset + order * size.rowHeight }));
  });
  const backEdges = new Set(graph.edges.filter((e) => back.has(edgeId(e)) || e.from === e.to).map(edgeId));
  return { nodes, backEdges, width: Math.max(1, layers.length) * size.colWidth, height: tallest * size.rowHeight };
}
