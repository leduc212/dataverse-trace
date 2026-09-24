import { describe, expect, it } from 'vitest';
import { buildCascade, edgeId, findCycles, layoutCascade } from './cascade.ts';
import { assembleTrace } from './correlate.ts';
import type { Trace } from './model.ts';
import type { TraceLogRecord } from './records.ts';
import { T0, traceLog } from './test-builders.ts';

const A = { stepId: 'contact-sync', typeName: 'Harbor.ContactSync', messageName: 'Update', primaryEntity: 'contact' };
const B = { stepId: 'account-count', typeName: 'Harbor.AccountCount', messageName: 'Update', primaryEntity: 'account' };
const C = { stepId: 'audit', typeName: 'Harbor.Audit', messageName: 'Update', primaryEntity: 'contact' };

/**
 * One operation where each entry runs one depth deeper, inside the one before: a chain of nested
 * requests, each fitting inside its parent (ms precision, so the parent is unambiguous).
 */
function chain(corr: string, steps: Array<Partial<TraceLogRecord> | Array<Partial<TraceLogRecord>>>): TraceLogRecord[] {
  const logs: TraceLogRecord[] = [];
  steps.forEach((entry, i) => {
    const depth = i + 1;
    const members = Array.isArray(entry) ? entry : [entry];
    members.forEach((m, j) =>
      // Each level has a quarter of the time of the one above, so up to two steps fit in their parent.
      logs.push(traceLog({ ...m, correlationId: corr, requestId: `${corr}-r${depth}`, depth, start: T0 + depth * 10 + j, durationMs: Math.floor(400_000 / 4 ** depth) - j, precision: 'ms' })),
    );
  });
  return logs;
}

function graphOf(...operations: TraceLogRecord[][]) {
  const logs = operations.flat();
  const traces = operations.map((op) => assembleTrace(op[0]!.correlationId!, { traceLogs: op, asyncOps: [], steps: new Map() })).filter((t): t is Trace => t !== null);
  return buildCascade(traces, new Map(logs.map((l) => [l.id, l])));
}

describe('buildCascade', () => {
  it('draws an edge from each step to the steps of the request it caused', () => {
    const g = graphOf(chain('op1', [A, [B, C]]), chain('op2', [A, B]));
    expect(g.operations).toBe(2);
    expect(g.edges.map((e) => [e.from, e.to, e.count, e.ambiguous])).toEqual([
      ['contact-sync', 'account-count', 2, 0],
      ['contact-sync', 'audit', 1, 0],
    ]);
    expect(g.edges[0]!.examples).toEqual(['op1', 'op2']);
    expect(g.nodes.find((n) => n.key === 'contact-sync')).toMatchObject({ runs: 2, maxDepth: 1, typeName: 'Harbor.ContactSync' });
    expect(g.cycles).toEqual([]);
  });

  it('finds the loop, with the operations where the whole loop happened', () => {
    const g = graphOf(chain('loop1', [A, B, A, B, A]), chain('loop2', [A, B, A]), chain('once', [A, B]));
    expect(g.cycles).toEqual([{ nodes: ['account-count', 'contact-sync'], examples: ['loop1', 'loop2'], operations: 2 }]);
    expect(g.nodes.find((n) => n.key === 'contact-sync')!.maxDepth).toBe(5);
  });

  it('ignores operations without nesting', () => {
    const g = graphOf([traceLog({ correlationId: 'flat', depth: 1 })]);
    expect(g).toEqual({ nodes: [], edges: [], cycles: [], operations: 0 });
  });
});

describe('findCycles', () => {
  it('returns strongly connected components with a cycle, including self-loops', () => {
    const edges = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'c', to: 'd' },
      { from: 'e', to: 'e' },
      { from: 'f', to: 'g' },
    ];
    expect(findCycles(['a', 'b', 'c', 'd', 'e', 'f', 'g'], edges)).toEqual([['a', 'b', 'c'], ['e']]);
    expect(findCycles(['x'], [])).toEqual([]);
  });

  it('handles long chains without recursion', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `n${i}`);
    const edges = keys.slice(1).map((k, i) => ({ from: keys[i]!, to: k }));
    edges.push({ from: keys[keys.length - 1]!, to: keys[0]! });
    expect(findCycles(keys, edges)[0]).toHaveLength(5000);
  });
});

describe('layoutCascade', () => {
  const node = (key: string) => ({ key, stepId: key, typeName: key, messageName: 'Update', primaryEntity: 't', mode: 'sync' as const, runs: 1, maxDepth: 1 });

  it('puts callers left of what they cause, and marks the edge that closes a loop', () => {
    const layout = layoutCascade({
      nodes: ['a', 'b', 'c'].map(node),
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b' },
      ].map((e) => ({ ...e, count: 1, ambiguous: 0, p95Ms: 1, examples: [] })),
    });
    expect(['a', 'b', 'c'].map((k) => layout.nodes.get(k)!.layer)).toEqual([0, 1, 2]);
    expect([...layout.backEdges]).toEqual([edgeId({ from: 'c', to: 'b' })]);
    expect(layout.width).toBe(3 * 260);
  });

  it('orders a layer to follow its parents, which avoids crossings', () => {
    const layout = layoutCascade({
      nodes: ['a1', 'a2', 'z', 'y'].map(node),
      edges: [
        { from: 'a1', to: 'z' },
        { from: 'a2', to: 'y' },
      ].map((e) => ({ ...e, count: 1, ambiguous: 0, p95Ms: 1, examples: [] })),
    });
    // Alphabetically y would come first, but it belongs to a2, which is below a1.
    expect(layout.nodes.get('z')!.order).toBeLessThan(layout.nodes.get('y')!.order);
    expect(layout.height).toBe(2 * 72);
  });

  it('draws self-loops as back edges', () => {
    const layout = layoutCascade({ nodes: [node('s')], edges: [{ from: 's', to: 's', count: 3, ambiguous: 0, p95Ms: 1, examples: [] }] });
    expect(layout.backEdges.has(edgeId({ from: 's', to: 's' }))).toBe(true);
  });
});
