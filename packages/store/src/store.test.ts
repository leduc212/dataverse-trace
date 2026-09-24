import 'fake-indexeddb/auto';
import { buildRollups, type AsyncOperationRecord, type TraceLogRecord } from '@dvt/core';
import { Dexie } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { databaseName, LocalStore, RAW_FROM } from './store.ts';

const T0 = Date.UTC(2026, 8, 24, 8, 0, 0);
let n = 0;
const log = (p: Partial<TraceLogRecord> = {}): TraceLogRecord => ({
  id: `log-${++n}`,
  correlationId: 'c1',
  requestId: 'r1',
  stepId: 'step-1',
  typeName: 'T',
  messageName: 'Update',
  primaryEntity: 'account',
  mode: 'sync',
  operationType: 'plugin',
  depth: 1,
  start: T0,
  durationMs: 10,
  constructorMs: 1,
  createdOn: T0,
  createdById: null,
  createdByName: null,
  exception: null,
  messageBlockLength: null,
  precision: 's',
  ...p,
});
const job = (p: Partial<AsyncOperationRecord> = {}): AsyncOperationRecord => ({
  id: `job-${++n}`,
  name: 'J',
  correlationId: 'c1',
  requestId: 'r1',
  operationType: 1,
  operationTypeLabel: 'System Event',
  statusCode: 30,
  statusLabel: 'Succeeded',
  depth: 1,
  stepId: 'step-2',
  workflowId: null,
  regarding: null,
  primaryEntity: 'account',
  messageName: 'Update',
  createdOn: T0,
  startedOn: T0,
  completedOn: T0,
  modifiedOn: T0,
  retryCount: 0,
  errorCode: null,
  message: null,
  precision: 's',
  ...p,
});

const stores: LocalStore[] = [];
const open = (env = `env-${++n}`) => {
  const s = new LocalStore(env);
  stores.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.destroy()));
});

describe('LocalStore', () => {
  it('upserts trace logs and queries them by correlation', async () => {
    const store = open();
    await store.putTraceLogs([log({ id: 'a' }), log({ id: 'b', correlationId: 'c2' })]);
    await store.putTraceLogs([log({ id: 'a', durationMs: 99 })]);
    expect((await store.allTraceLogs()).length).toBe(2);
    expect((await store.traceLogsByCorrelation('c1')).map((l) => [l.id, l.durationMs])).toEqual([['a', 99]]);
  });

  it('stores trace text, records its length, and keeps it when the row is re-read', async () => {
    const store = open();
    await store.putTraceLogs([log({ id: 'a' }), log({ id: 'b' })]);
    await store.putTraceBlobs([
      { id: 'a', messageBlock: 'hello' },
      { id: 'b', messageBlock: null },
    ]);
    await store.putTraceLogs([log({ id: 'a' })]);
    const byId = new Map((await store.allTraceLogs()).map((l) => [l.id, l]));
    expect(byId.get('a')!.messageBlockLength).toBe(5);
    expect(byId.get('b')!.messageBlockLength).toBe(0);
    expect(await store.blob('a')).toEqual({ id: 'a', messageBlock: 'hello' });
    const seen: string[] = [];
    await store.eachBlob((b) => seen.push(b.id));
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('knows referenced and known step ids', async () => {
    const store = open();
    await store.putTraceLogs([log({ stepId: 's1' }), log({ stepId: null })]);
    await store.putAsyncOperations([job({ stepId: 's2' }), job({ stepId: null })]);
    await store.putSteps([{ id: 's1' } as never]);
    expect([...(await store.referencedStepIds())].sort()).toEqual(['s1', 's2']);
    expect([...(await store.knownStepIds())]).toEqual(['s1']);
  });

  it('persists sync state and metadata', async () => {
    const store = open();
    await store.putSourceState({ source: 'traceLogs', watermark: T0, lastRunAt: T0, lastOkAt: T0, lastError: null, gaps: [[1, 2]], firstOkAt: T0 });
    await store.setMeta('capabilities', { ok: true });
    expect(await store.getSourceState('traceLogs')).toMatchObject({ watermark: T0, gaps: [[1, 2]] });
    expect(await store.getMeta('capabilities')).toEqual({ ok: true });
  });

  it('stores flow runs and flow events, and replaces processes as a set', async () => {
    const store = open();
    await store.putFlowRuns([{ id: 'r1', modifiedOn: T0 } as never]);
    await store.putFlowEvents([{ id: 'e1', createdOn: T0 } as never]);
    await store.replaceProcesses([{ id: 'p1' } as never, { id: 'p2' } as never]);
    await store.replaceProcesses([{ id: 'p3' } as never]);
    expect((await store.allFlowRuns()).map((r) => r.id)).toEqual(['r1']);
    expect((await store.allFlowEvents()).map((r) => r.id)).toEqual(['e1']);
    expect((await store.allProcesses()).map((p) => p.id)).toEqual(['p3']);
  });

  it('keeps environments separate', async () => {
    const a = open('a.crm.dynamics.com');
    const b = open('b.crm.dynamics.com');
    await a.putTraceLogs([log()]);
    expect((await b.allTraceLogs()).length).toBe(0);
  });

  it('applies retention: raw rows, then trace text, then rollups, and remembers where raw rows start', async () => {
    const store = open();
    const DAY = 86_400_000;
    const now = T0 + 100 * DAY;
    const retention = { rawMs: 30 * DAY, blobsMs: 14 * DAY, rollupsMs: 90 * DAY };
    await store.putTraceLogs([
      log({ id: 'ancient', createdOn: T0, start: T0 }),
      log({ id: 'old', createdOn: now - 40 * DAY, start: now - 40 * DAY }),
      log({ id: 'mid', createdOn: now - 20 * DAY, start: now - 20 * DAY }),
      log({ id: 'new', createdOn: now - DAY, start: now - DAY }),
    ]);
    await store.putTraceBlobs([
      { id: 'old', messageBlock: 'x' },
      { id: 'mid', messageBlock: 'y' },
      { id: 'new', messageBlock: 'z' },
    ]);
    await store.putAsyncOperations([job({ modifiedOn: now - 31 * DAY }), job({ modifiedOn: now })]);
    expect(await store.getMeta(RAW_FROM)).toBeUndefined();
    expect(await store.prune(now, retention)).toEqual({ traceLogs: 2, traceBlobs: 2, asyncOps: 1, flowRuns: 0, rollups: 1 });
    expect((await store.allTraceLogs()).map((l) => l.id).sort()).toEqual(['mid', 'new']);
    expect(await store.blob('mid')).toBeUndefined();
    expect(await store.blob('new')).toBeDefined();
    // The 40-day-old hour keeps its rollup after its raw row is gone; the 100-day-old one doesn't.
    expect((await store.rollupsBetween(0, Infinity)).map((r) => r.hour)).toEqual([now - 40 * DAY, now - 20 * DAY, now - DAY]);
    expect(await store.getMeta(RAW_FROM)).toBe(now - 30 * DAY);
    expect(await store.summary()).toEqual({ traceLogs: 2, traceBlobs: 1, asyncOps: 1, steps: 0, flowRuns: 0, processes: 0, rollups: 3, oldest: now - 20 * DAY, newest: now - DAY });
    expect(await store.prune(now, retention)).toEqual({ traceLogs: 0, traceBlobs: 0, asyncOps: 0, flowRuns: 0, rollups: 0 });
  });
});

describe('rollups', () => {
  const H = 3_600_000;

  it('rebuilds the hours touched by each write, including re-read rows that moved', async () => {
    const store = open();
    await store.putTraceLogs([log({ id: 'a', start: T0 + 10, durationMs: 100 }), log({ id: 'b', start: T0 + H + 10, exception: 'boom' })]);
    let rollups = await store.rollupsBetween(T0, T0 + 2 * H);
    expect(rollups.map((r) => [r.hour, r.count, r.errors])).toEqual([
      [T0, 1, 0],
      [T0 + H, 1, 1],
    ]);
    // Row "a" re-read with a later start: its old hour empties, the new hour counts it.
    await store.putTraceLogs([log({ id: 'a', start: T0 + H + 20, durationMs: 100 })]);
    rollups = await store.rollupsBetween(T0, T0 + 2 * H);
    expect(rollups.map((r) => [r.hour, r.count])).toEqual([[T0 + H, 2]]);
    expect(await store.oldestRollupHour()).toBe(T0 + H);
  });

  it('counts truncated trace text once the text arrives', async () => {
    const store = open();
    await store.putTraceLogs([log({ id: 'a' }), log({ id: 'b' })]);
    await store.putTraceBlobs([
      { id: 'a', messageBlock: 'x'.repeat(10_000) },
      { id: 'b', messageBlock: 'short' },
    ]);
    const [r] = await store.rollupsBetween(0, Infinity);
    expect(r).toMatchObject({ count: 2, textKnown: 2, truncated: 1 });
  });

  it('stores imported rollups as they are', async () => {
    const store = open();
    const [r] = buildRollups([log({ start: T0 - 50 * H })]);
    await store.putRollups([r!]);
    expect(await store.rollupsBetween(T0 - 100 * H, T0)).toEqual([r]);
    expect(await store.rollupsBetween(T0, T0 + H)).toEqual([]);
  });

  it('builds rollups for rows stored before the upgrade', async () => {
    const name = `env-${++n}`;
    const legacy = new Dexie(databaseName(name));
    legacy.version(2).stores({
      traceLogs: 'id, createdOn, start, correlationId, stepId',
      traceBlobs: 'id',
      asyncOps: 'id, correlationId, modifiedOn, stepId',
      steps: 'id',
      sourceState: 'source',
      meta: 'key',
      flowRuns: 'id, start, modifiedOn, workflowId, runId, parentRunId',
      flowEvents: 'id, createdOn',
      processes: 'id',
    });
    await legacy.table('traceLogs').bulkPut([log({ id: 'x' }), log({ id: 'y', start: T0 + H })]);
    legacy.close();
    const store = open(name);
    expect((await store.rollupsBetween(0, Infinity)).map((r) => r.count)).toEqual([1, 1]);
  });
});
