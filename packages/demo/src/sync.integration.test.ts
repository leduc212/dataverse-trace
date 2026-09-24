// The real SyncEngine and capability probe against the demo environment.
import type { AsyncOperationRecord, StepRegistration, TraceBlob, TraceLogRecord } from '@dvt/core';
import { DAY_MS, SyncEngine, probeCapabilities, type SourceName, type SourceState, type SyncStore } from '@dvt/dataverse';
import { describe, expect, it } from 'vitest';
import { generateDemo } from './generator.ts';
import { MockTransport } from './mock-transport.ts';

const NOW = Date.UTC(2026, 8, 24, 15, 0, 0);
const data = generateDemo({ now: NOW, days: 3, scale: 0.3 });

class MemoryStore implements SyncStore {
  states = new Map<SourceName, SourceState>();
  traceLogs = new Map<string, TraceLogRecord>();
  blobs = new Map<string, TraceBlob>();
  jobs = new Map<string, AsyncOperationRecord>();
  steps = new Map<string, StepRegistration>();
  writes = 0;
  async getSourceState(source: SourceName) {
    const s = this.states.get(source);
    return s ? structuredClone(s) : undefined;
  }
  async putSourceState(state: SourceState) {
    this.states.set(state.source, structuredClone(state));
  }
  async putTraceLogs(rows: TraceLogRecord[]) {
    this.writes += rows.length;
    rows.forEach((r) => this.traceLogs.set(r.id, r));
  }
  async putTraceBlobs(rows: TraceBlob[]) {
    rows.forEach((r) => this.blobs.set(r.id, r));
  }
  async putAsyncOperations(rows: AsyncOperationRecord[]) {
    rows.forEach((r) => this.jobs.set(r.id, r));
  }
  async putSteps(rows: StepRegistration[]) {
    rows.forEach((r) => this.steps.set(r.id, r));
  }
  async referencedStepIds() {
    return new Set([...this.traceLogs.values()].map((l) => l.stepId).concat([...this.jobs.values()].map((j) => j.stepId)).filter((x): x is string => Boolean(x)));
  }
  async knownStepIds() {
    return new Set(this.steps.keys());
  }
}

const engine = (store: MemoryStore, transport: MockTransport, now = NOW, canRead: boolean | null = true) =>
  new SyncEngine({ transport, store, now: () => now, canReadTraceText: () => canRead, metadataPageSize: 500, blobPageSize: 300 });

describe('SyncEngine against the demo environment', () => {
  it('pulls every trace log, blob, relevant job and referenced step', async () => {
    const store = new MemoryStore();
    const report = await engine(store, new MockTransport(data)).syncAll();
    expect(report.results.map((r) => r.phase)).toEqual(['done', 'done', 'done', 'done']);
    expect(store.traceLogs.size).toBe(data.traceLogs.length);
    expect(store.blobs.size).toBe(data.traceLogs.length);
    expect(store.jobs.size).toBe(data.asyncOperations.length);
    expect(store.steps.size).toBe(data.steps.length);
    expect(store.states.get('traceLogs')!.watermark).toBe(Math.max(...[...store.traceLogs.values()].map((l) => l.createdOn)));
  });

  it('is incremental: a second run only re-reads the last second', async () => {
    const store = new MemoryStore();
    const transport = new MockTransport(data);
    await engine(store, transport).syncTraceLogs();
    const firstWrites = store.writes;
    await engine(store, transport, NOW + 60_000).syncTraceLogs();
    expect(store.writes - firstWrites).toBeLessThan(10);
    expect(store.traceLogs.size).toBe(data.traceLogs.length);
  });

  it('resumes after an abort without losing or duplicating rows', async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    const transport = new MockTransport(data);
    const e = new SyncEngine({
      transport,
      store,
      now: () => NOW,
      metadataPageSize: 200,
      onProgress: (p) => {
        if (p.fetched >= 400) controller.abort();
      },
    });
    const first = await e.syncTraceLogs(controller.signal);
    expect(first.phase).toBe('error');
    expect(store.traceLogs.size).toBeGreaterThanOrEqual(400);
    expect(store.traceLogs.size).toBeLessThan(data.traceLogs.length);
    await engine(store, transport).syncTraceLogs();
    expect(store.traceLogs.size).toBe(data.traceLogs.length);
  });

  it('records a possible gap when the last successful sync is older than a day', async () => {
    const store = new MemoryStore();
    const transport = new MockTransport(data);
    await engine(store, transport, NOW).syncTraceLogs();
    await engine(store, transport, NOW + 2 * DAY_MS).syncTraceLogs();
    expect(store.states.get('traceLogs')!.gaps).toEqual([[NOW, NOW + DAY_MS]]);
  });

  it('skips the blob lane when trace text is unreadable', async () => {
    const store = new MemoryStore();
    const result = await engine(store, new MockTransport(data), NOW, false).syncTraceBlobs();
    expect(result.phase).toBe('skipped');
    expect(store.blobs.size).toBe(0);
  });

  it('reports errors per source and keeps going', async () => {
    const store = new MemoryStore();
    const report = await engine(store, new MockTransport(data, { forbidden: ['asyncoperations'] })).syncAll();
    expect(report.results.find((r) => r.source === 'asyncOps')).toMatchObject({ phase: 'error' });
    expect(report.results.find((r) => r.source === 'traceLogs')).toMatchObject({ phase: 'done' });
    expect(store.states.get('asyncOps')!.lastError).toContain('prvRead');
  });
});

describe('probeCapabilities against the demo environment', () => {
  it('sees an administrator with tracing on', async () => {
    const caps = await probeCapabilities(new MockTransport(data), () => NOW);
    expect(caps).toMatchObject({
      userId: data.userId,
      canReadTraceLogs: true,
      canReadTraceText: true,
      isSystemAdministrator: true,
      canReadAsyncOperations: true,
      settings: { pluginTraceLogSetting: 2 },
    });
    expect(caps.notes).toEqual([]);
  });

  it('explains missing privileges and tracing being off', async () => {
    const off = { ...data, organization: { ...data.organization, plugintracelogsetting: 0 }, userRoles: [] };
    const caps = await probeCapabilities(new MockTransport(off, { forbidden: ['asyncoperations'] }));
    expect(caps.canReadAsyncOperations).toBe(false);
    expect(caps.canReadTraceText).toBe(false);
    expect(caps.notes.join('\n')).toMatch(/Off[\s\S]*system jobs[\s\S]*System Administrators/);
  });
});

describe('MockTransport', () => {
  it('pages with next links and honours $top', async () => {
    const t = new MockTransport(data);
    const page = await t.get<{ value: unknown[]; '@odata.nextLink'?: string }>('plugintracelogs?$select=plugintracelogid&$orderby=createdon asc', { maxPageSize: 10 });
    expect(page.value).toHaveLength(10);
    const next = await t.get<{ value: unknown[] }>(page['@odata.nextLink']!, { maxPageSize: 10 });
    expect(next.value).toHaveLength(10);
    expect(next.value[0]).not.toEqual(page.value[0]);
    const top = await t.get<{ value: unknown[]; '@odata.nextLink'?: string }>('plugintracelogs?$top=3');
    expect(top.value).toHaveLength(3);
    expect(top['@odata.nextLink']).toBeUndefined();
  });

  it('answers 404 for unknown resources', async () => {
    await expect(new MockTransport(data).get('flowruns')).rejects.toMatchObject({ status: 404 });
  });
});

