// Explorer queries: filter by time range + query language, build the histogram, facets and rows.
import { matchesQuery, parseQuery, type TraceLogRecord } from '@dvt/core';
import { RANGE_MS, type ExplorerRow, type FacetValue, type Facets, type HistogramBucket, type LogQuery } from '../shared/api.ts';
import type { Dataset } from './dataset.ts';

const NICE_BUCKETS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 7 * 86_400_000];

export function bucketSizeFor(spanMs: number, maxBuckets = 96): number {
  return NICE_BUCKETS_MS.find((size) => spanMs / size <= maxBuckets) ?? NICE_BUCKETS_MS[NICE_BUCKETS_MS.length - 1]!;
}

export function histogram(logs: readonly TraceLogRecord[], from: number, to: number): HistogramBucket[] {
  const size = bucketSizeFor(Math.max(to - from, 60_000));
  const first = Math.floor(from / size) * size;
  const count = Math.max(1, Math.ceil((to - first) / size));
  const buckets: HistogramBucket[] = Array.from({ length: count }, (_, i) => ({ start: first + i * size, end: first + (i + 1) * size, ok: 0, errors: 0 }));
  for (const log of logs) {
    const b = buckets[Math.floor((log.start - first) / size)];
    if (!b) continue;
    if (log.exception) b.errors++;
    else b.ok++;
  }
  return buckets;
}

function topValues(logs: readonly TraceLogRecord[], pick: (l: TraceLogRecord) => string | null, limit = 8): FacetValue[] {
  const counts = new Map<string, number>();
  for (const l of logs) {
    const v = pick(l);
    if (v === null || v === '') continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

export function facets(logs: readonly TraceLogRecord[]): Facets {
  return {
    typeName: topValues(logs, (l) => l.typeName),
    messageName: topValues(logs, (l) => l.messageName),
    primaryEntity: topValues(logs, (l) => l.primaryEntity),
    mode: topValues(logs, (l) => l.mode),
    depth: topValues(logs, (l) => String(l.depth), 10).sort((a, b) => Number(a.value) - Number(b.value)),
  };
}

export interface ExploreOutput {
  rows: ExplorerRow[];
  matched: TraceLogRecord[];
  parseErrors: string[];
  from: number | null;
  to: number;
}

export function explore(data: Dataset, q: LogQuery, now: number, blobText: (id: string) => string | undefined): ExploreOutput {
  const parsed = parseQuery(q.text);
  const span = RANGE_MS[q.range];
  const from = span === null ? null : now - span;
  const matched: TraceLogRecord[] = [];
  for (const log of data.logs) {
    if (from !== null && log.start < from) break; // logs are newest first
    if (matchesQuery(log, parsed, parsed.text.length ? blobText(log.id) : undefined)) matched.push(log);
  }

  let rows: ExplorerRow[];
  if (q.view === 'operations') {
    const counts = new Map<string, number>();
    for (const log of matched) if (log.correlationId) counts.set(log.correlationId, (counts.get(log.correlationId) ?? 0) + 1);
    rows = [...counts.entries()].flatMap(([id, n]) => {
      const op = data.operations.get(id);
      return op ? [{ kind: 'operation' as const, op, matched: n }] : [];
    });
    const key = (r: ExplorerRow) => (r.kind === 'operation' ? r.op : null)!;
    if (q.sort === 'slowest') rows.sort((a, b) => key(b).end - key(b).start - (key(a).end - key(a).start));
    else if (q.sort === 'oldest') rows.sort((a, b) => key(a).start - key(b).start);
    else rows.sort((a, b) => key(b).start - key(a).start);
  } else {
    const logs = [...matched];
    if (q.sort === 'slowest') logs.sort((a, b) => b.durationMs - a.durationMs);
    else if (q.sort === 'oldest') logs.reverse();
    rows = logs.map((log) => ({ kind: 'execution' as const, log }));
  }
  return { rows, matched, parseErrors: parsed.errors, from, to: now };
}
