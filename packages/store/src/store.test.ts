import 'fake-indexeddb/auto';
import type { AsyncOperationRecord, TraceLogRecord } from '@dvt/core';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStore } from './store.ts';

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

  it('prunes old rows and their text, and summarises storage', async () => {
    const store = open();
    await store.putTraceLogs([log({ id: 'old', createdOn: T0 - 1000, start: T0 - 1000 }), log({ id: 'new', createdOn: T0 + 1000, start: T0 + 1000 })]);
    await store.putTraceBlobs([{ id: 'old', messageBlock: 'x' }]);
    await store.putAsyncOperations([job({ modifiedOn: T0 - 1 }), job({ modifiedOn: T0 + 1 })]);
    expect(await store.prune(T0)).toEqual({ traceLogs: 1, asyncOps: 1, flowRuns: 0 });
    expect(await store.summary()).toEqual({ traceLogs: 1, traceBlobs: 0, asyncOps: 1, steps: 0, flowRuns: 0, processes: 0, oldest: T0 + 1000, newest: T0 + 1000 });
  });
});
