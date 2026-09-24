// The real SyncEngine and capability probe against the demo environment.
import { newSnapshots, snapshotKey, type AsyncOperationRecord, type FlowEventRecord, type FlowRunRecord, type PluginTypeStatRecord, type PluginTypeStatSnapshot, type ProcessDefinition, type StepRegistration, type TraceBlob, type TraceLogRecord } from '@dvt/core';
import { DAY_MS, SyncEngine, fetchAudits, fetchEntityMetadata, fetchOrganization, fetchRecord, fetchStepsForTable, probeCapabilities, searchRecords, setTraceSetting, type SourceName, type SourceState, type SyncStore } from '@dvt/dataverse';
import { describe, expect, it } from 'vitest';
import { generateDemo, simulateSave } from './generator.ts';
import { MockTransport } from './mock-transport.ts';

const NOW = Date.UTC(2026, 8, 24, 15, 0, 0);
const data = generateDemo({ now: NOW, days: 3, scale: 0.3 });

class MemoryStore implements SyncStore {
  states = new Map<SourceName, SourceState>();
  traceLogs = new Map<string, TraceLogRecord>();
  blobs = new Map<string, TraceBlob>();
  jobs = new Map<string, AsyncOperationRecord>();
  steps = new Map<string, StepRegistration>();
  flowRuns = new Map<string, FlowRunRecord>();
  flowEvents = new Map<string, FlowEventRecord>();
  processes: ProcessDefinition[] = [];
  pluginStats = new Map<string, PluginTypeStatSnapshot>();
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
  async putFlowRuns(rows: FlowRunRecord[]) {
    rows.forEach((r) => this.flowRuns.set(r.id, r));
  }
  async putFlowEvents(rows: FlowEventRecord[]) {
    rows.forEach((r) => this.flowEvents.set(r.id, r));
  }
  async replaceProcesses(rows: ProcessDefinition[]) {
    this.processes = rows;
  }
  async putPluginStats(rows: PluginTypeStatRecord[], takenAt: number) {
    const fresh = newSnapshots(rows, new Set(this.pluginStats.keys()), takenAt);
    fresh.forEach((r) => this.pluginStats.set(snapshotKey(r), r));
    return fresh.length;
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
    expect(report.results.map((r) => [r.source, r.phase])).toEqual(
      ['traceLogs', 'asyncOps', 'steps', 'flowRuns', 'flowEvents', 'processes', 'pluginStats', 'traceBlobs'].map((s) => [s, 'done']),
    );
    expect(store.pluginStats.size).toBe(data.pluginTypeStatistics.length);
    expect([...store.pluginStats.values()].find((s) => s.typeName === 'Harbor.Plugins.ContactAudit')).toMatchObject({ failureCount: 0, failurePercent: 0 });
    expect(store.traceLogs.size).toBe(data.traceLogs.length);
    expect(store.blobs.size).toBe(data.traceLogs.length);
    expect(store.jobs.size).toBe(data.asyncOperations.length);
    expect(store.steps.size).toBe(data.steps.length);
    expect(store.states.get('traceLogs')!.watermark).toBe(Math.max(...[...store.traceLogs.values()].map((l) => l.createdOn)));
    expect(store.flowRuns.size).toBe(data.flowRuns.length);
    expect(store.flowEvents.size).toBe(data.flowEvents.length);
  });

  it('reads processes: workflow activations fold into their definition, flows get their trigger', async () => {
    const store = new MemoryStore();
    await engine(store, new MockTransport(data)).syncProcesses();
    const byName = new Map(store.processes.map((p) => [p.name, p]));
    expect(byName.get('Calculate policy risk')).toMatchObject({ category: 'workflow', active: true, mode: 'background', triggerOnCreate: true });
    expect(byName.get('Calculate policy risk')!.activationIds).toContain('5b1f0e7a-3c2d-4e8f-9a61-0d7c2b4e9f13');
    expect(byName.get('Notify underwriter on status change')!.flowTrigger).toMatchObject({
      table: 'hbr_policy',
      changes: ['update'],
      filteringAttributes: ['hbr_status'],
      filterExpression: 'hbr_premium gt 1000',
    });
    expect(byName.get('Legacy renewal reminder')!.active).toBe(false);
    // Live trigger subscriptions: every active flow with a row trigger has one; others aren't checked.
    expect(byName.get('Notify underwriter on status change')!.subscription).toBe('found');
    expect(byName.get('Sync account to marketing')!.subscription).toBe('found');
    expect(byName.get('Legacy renewal reminder')!.subscription).toBeNull();
    expect(byName.get('Generate policy PDF')!.flowTrigger).toBeNull();
    expect(byName.get('Premium must be positive')!.category).toBe('businessRule');
  });

  it('leaves subscriptions unchecked when callback registrations are unreadable', async () => {
    const store = new MemoryStore();
    await engine(store, new MockTransport(data, { forbidden: ['callbackregistrations'] })).syncProcesses();
    expect(store.processes.filter((p) => p.category === 'flow').every((p) => p.subscription === null)).toBe(true);
  });

  it('skips sources the user cannot read', async () => {
    const store = new MemoryStore();
    const e = new SyncEngine({ transport: new MockTransport(data), store, now: () => NOW, canRead: (source) => source !== 'flowRuns' });
    expect((await e.syncFlowRuns()).phase).toBe('skipped');
    expect(store.flowRuns.size).toBe(0);
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
    await expect(new MockTransport(data).get('nothings')).rejects.toMatchObject({ status: 404 });
  });
});

describe('on-demand reads against the demo environment', () => {
  const transport = new MockTransport(data);
  const policyId = Object.keys(data.records['hbr_policy']!)[0]!;

  it('reads audit history with changed columns and new values', async () => {
    const audits = await fetchAudits(transport, policyId, { withDetails: 5 });
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.map((a) => a.createdOn)).toEqual([...audits.map((a) => a.createdOn)].sort((a, b) => b - a));
    const detailed = audits.filter((a) => a.changedColumns !== null);
    expect(detailed.length).toBe(Math.min(5, audits.length));
    for (const a of detailed) expect(Object.keys(a.newValues!).sort()).toEqual(a.changedColumns);
  });

  it('reads table metadata and a record', async () => {
    const meta = await fetchEntityMetadata(transport, 'hbr_policy');
    expect(meta).toEqual({ table: 'hbr_policy', entitySet: 'hbr_policies', primaryId: 'hbr_policyid', primaryName: 'hbr_name' });
    const record = await fetchRecord(transport, meta, policyId);
    expect(record.name).toMatch(/^HP-/);
    expect(record.values['hbr_premium']).toEqual(expect.any(Number));
  });

  it('searches records by name', async () => {
    const meta = await fetchEntityMetadata(transport, 'hbr_policy');
    expect(await searchRecords(transport, meta, 'HP-10000')).toEqual([{ table: 'hbr_policy', id: policyId, name: 'HP-10000' }]);
    expect(await searchRecords(transport, meta, "O'Brien & co")).toEqual([]);
  });

  it('reads steps for a table and message', async () => {
    const steps = await fetchStepsForTable(transport, 'hbr_policy', 'update');
    expect(steps.map((s) => s.pluginTypeName).sort()).toEqual(['Harbor.Plugins.PolicyErpSync', 'Harbor.Plugins.PolicyNotify', 'Harbor.Plugins.PolicyValidate']);
  });

  it('changes and restores the trace setting', async () => {
    const t = new MockTransport(structuredClone(data));
    const org = await fetchOrganization(t);
    expect(org).toEqual({ id: data.organizationId, traceSetting: 2 });
    await setTraceSetting(t, org.id, 0);
    expect((await fetchOrganization(t)).traceSetting).toBe(0);
    await setTraceSetting(t, org.id, 2);
    expect(t.patches.map((p) => p.body)).toEqual([{ plugintracelogsetting: 0 }, { plugintracelogsetting: 2 }]);
  });
});


describe('simulated saves (watch mode in the demo)', () => {
  it('reveals a live save over time, with ids that match the rest of the demo', async () => {
    const copy = structuredClone(data);
    let clock = NOW;
    const transport = new MockTransport(copy, {}, () => clock);
    const save = simulateSave(copy, { now: NOW });
    transport.schedule(save);
    const stepIds = new Set(copy.steps.map((s) => s['sdkmessageprocessingstepid']));
    const flowIds = new Set(copy.workflows.map((w) => w['workflowid']));
    const tables = new Set(save.rows.map((r) => r.table));
    expect([...tables].sort()).toEqual(['asyncoperations', 'audits', 'flowruns', 'plugintracelogs']);
    for (const r of save.rows) {
      if (r.table === 'plugintracelogs') expect(stepIds.has(r.row['pluginstepid'])).toBe(true);
      if (r.table === 'flowruns') expect(flowIds.has(r.row['_workflow_value'])).toBe(true);
      expect(r.at).toBeGreaterThanOrEqual(NOW);
      expect(r.at).toBeLessThan(NOW + 60_000);
    }
    const count = async () => (await transport.get<{ value: unknown[] }>(`audits?$filter=_objectid_value eq ${save.record.id}`)).value.length;
    const before = await count();
    expect(transport.pendingCount).toBe(save.rows.length);
    clock = NOW + 120_000;
    expect(await count()).toBe(before + 1);
    expect(transport.pendingCount).toBe(0);
  });
});

describe('plug-in type statistics', () => {
  it('are refreshed at most every 15 minutes, and a snapshot is kept only when Dataverse updates a row', async () => {
    const store = new MemoryStore();
    const transport = new MockTransport(data);
    expect(await engine(store, transport).syncPluginStats()).toMatchObject({ phase: 'done', fetched: data.pluginTypeStatistics.length });
    // Too soon: skipped without a request.
    expect(await engine(store, transport, NOW + 5 * 60_000).syncPluginStats()).toMatchObject({ phase: 'done', fetched: 0 });
    // Later, but Dataverse hasn't updated the counters: nothing new is stored.
    expect(await engine(store, transport, NOW + 20 * 60_000).syncPluginStats()).toMatchObject({ phase: 'done', fetched: 0 });
    expect(store.pluginStats.size).toBe(data.pluginTypeStatistics.length);
  });

  it('are skipped, not failed, without read access', async () => {
    const report = await new SyncEngine({ transport: new MockTransport(data), store: new MemoryStore(), now: () => NOW, canRead: (s) => s !== 'pluginStats' }).syncPluginStats();
    expect(report).toMatchObject({ phase: 'skipped' });
  });
});
