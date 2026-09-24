// Implements the WorkerApi. Owns the store, the transport, the sync loop and the in-memory indexes.
import {
  assembleTrace,
  buildRecordStory,
  expectedFor,
  findSaves,
  layoutWaterfall,
  parseQuery,
  type AuditRecord,
  type ChangeKind,
  type Observed,
  type RecordRef,
  type SaveEvent,
  type StepRegistration,
} from '@dvt/core';
import {
  FetchTransport,
  SyncEngine,
  fetchAuditDetails,
  fetchAudits,
  fetchEntityMetadata,
  fetchOrganization,
  fetchRecord,
  fetchStepsForTable,
  probeCapabilities,
  searchRecords,
  setTraceSetting,
  type Capabilities,
  type EntityMetadata,
  type SourceName,
  type SyncProgress,
  type Transport,
} from '@dvt/dataverse';
import type { DemoDataset, MockTransport } from '@dvt/demo';
import { LocalStore } from '@dvt/store';
import type {
  DashboardData,
  ExecutionDetail,
  ExpectedRequest,
  ExpectedResult,
  ExplorerRow,
  ExportContext,
  HostInfo,
  RecentRecord,
  RecordInfo,
  RecordSaves,
  RecordStoryView,
  LogQuery,
  LogQueryResult,
  RangeKey,
  Status,
  TraceView,
  WatchStatus,
  WatchView,
  WorkerApi,
} from '../shared/api.ts';
import { Dataset } from './dataset.ts';
import { explore, facets, histogram } from './explore.ts';
import { dashboard } from './insights.ts';

const SYNC_INTERVAL_MS = 5 * 60_000;
/** Cap on trace text kept in memory for full-text search (characters). */
const TEXT_CACHE_LIMIT = 60_000_000;
const MAX_CACHED_QUERIES = 4;
const MINUTE = 60_000;
const WATCH_POLL_MS = 2000;
/** Watch stops after this long without new rows. */
const WATCH_IDLE_MS = 60_000;
const WATCH_MAX_MS = 15 * MINUTE;
const PENDING_RESTORE = 'pendingRestore';
const TRACE_LABELS = ['Off', 'Exceptions', 'All'] as const;

interface PendingRestore {
  organizationId: string;
  value: 0 | 1 | 2;
  at: number;
}

const idleWatch = (canSimulate = false): WatchStatus => ({
  phase: 'idle',
  record: null,
  startedAt: null,
  stoppedAt: null,
  lastNewAt: null,
  idleStopAt: null,
  polls: 0,
  requests: 0,
  traceSwitch: null,
  stopReason: null,
  note: null,
  error: null,
  canSimulate,
});

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Engine implements WorkerApi {
  #host: HostInfo | null = null;
  #store: LocalStore | null = null;
  #transport: Transport | null = null;
  #capabilities: Capabilities | null = null;
  #data = Dataset.empty();
  #listeners: Array<(s: Status) => void> = [];
  #status: Status = {
    host: null,
    ready: false,
    capabilities: null,
    sources: [],
    storage: null,
    syncing: false,
    progress: [],
    lastSyncAt: null,
    throttledUntil: null,
    error: null,
    dataVersion: 0,
    watch: idleWatch(),
  };
  #demo: DemoDataset | null = null;
  #metadata = new Map<string, Promise<EntityMetadata>>();
  #audits = new Map<string, AuditRecord[]>();
  #stepsFor = new Map<string, Promise<StepRegistration[]>>();
  #recent = new Map<string, RecentRecord>();
  #watchTimer: ReturnType<typeof setInterval> | null = null;
  #watchBusy = false;
  #watchOrgId: string | null = null;
  #queries = new Map<number, ExplorerRow[]>();
  #nextQueryId = 1;
  #textCache: Map<string, string> | null = null;
  #textCacheLimited = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #channel: BroadcastChannel | null = null;
  #emitScheduled = false;
  #initPromise: Promise<void> | null = null;

  readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  init(host: HostInfo): Promise<void> {
    this.#initPromise ??= this.#init(host);
    return this.#initPromise;
  }

  async #init(host: HostInfo): Promise<void> {
    this.#host = host;
    this.#status.host = host;
    try {
      if (host.kind === 'demo') {
        // Fresh demo every visit: generated relative to "now", so it always looks current.
        await new LocalStore('demo').destroy();
        const { generateDemo, MockTransport } = await import('@dvt/demo');
        this.#demo = generateDemo();
        this.#transport = new MockTransport(this.#demo);
        this.#status.watch = idleWatch(true);
      } else {
        this.#transport = new FetchTransport({
          origin: host.origin,
          onThrottle: (waitMs) => {
            this.#status.throttledUntil = this.clock() + waitMs;
            this.#emit();
          },
        });
      }
      this.#store = new LocalStore(host.kind === 'demo' ? 'demo' : host.envKey);
      this.#capabilities = await probeCapabilities(this.#transport, this.clock);
      this.#status.capabilities = this.#capabilities;
      await this.#store.setMeta('capabilities', this.#capabilities);
      await this.#restorePending();
      await this.#reload();
      this.#status.ready = true;
      this.#emit();

      if (typeof BroadcastChannel !== 'undefined' && host.kind === 'environment') {
        this.#channel = new BroadcastChannel(`dataverse-trace:${host.envKey}`);
        this.#channel.onmessage = () => void this.#reload().then(() => this.#emit());
      }
      void this.syncNow();
      if (host.kind === 'environment') this.#timer = setInterval(() => void this.syncNow(), SYNC_INTERVAL_MS);
    } catch (e) {
      this.#status.error = e instanceof Error ? e.message : String(e);
      this.#status.ready = true;
      this.#emit();
    }
  }

  async #reload(): Promise<void> {
    const store = this.#store!;
    const [logs, jobs, steps, sources, storage, flowRuns, processes, flowEvents] = await Promise.all([
      store.allTraceLogs(),
      store.allAsyncOperations(),
      store.allSteps(),
      store.allSourceStates(),
      store.summary(),
      store.allFlowRuns(),
      store.allProcesses(),
      store.allFlowEvents(),
    ]);
    this.#data = new Dataset(logs, jobs, steps, flowRuns, processes, flowEvents);
    this.#status.sources = sources;
    this.#status.storage = storage;
    this.#status.dataVersion++;
    this.#queries.clear();
    this.#textCache = null;
  }

  subscribe(listener: (status: Status) => void): void {
    this.#listeners.push(listener);
    listener(this.#status);
  }

  async getStatus(): Promise<Status> {
    return this.#status;
  }

  /** Batches status updates to at most one per animation-frame-ish tick. */
  #emit(): void {
    if (this.#emitScheduled) return;
    this.#emitScheduled = true;
    setTimeout(() => {
      this.#emitScheduled = false;
      const snapshot = structuredClone(this.#status);
      for (const l of this.#listeners) {
        // Listeners are Comlink proxies; a closed tab's proxy rejects, which is fine to ignore.
        Promise.resolve(l(snapshot) as unknown).catch(() => {});
      }
    }, 120);
  }

  #canRead(source: SourceName): boolean | null {
    const c = this.#capabilities;
    if (!c) return null;
    switch (source) {
      case 'traceLogs':
      case 'traceBlobs':
        return c.canReadTraceLogs;
      case 'asyncOps':
        return c.canReadAsyncOperations;
      case 'steps':
        return c.canReadSteps;
      case 'flowRuns':
      case 'flowEvents':
        return c.canReadFlowRuns;
      case 'processes':
        return c.canReadProcesses;
    }
  }

  #syncEngine(onProgress?: (p: SyncProgress) => void): SyncEngine {
    return new SyncEngine({
      transport: this.#transport!,
      store: this.#store!,
      now: this.clock,
      canReadTraceText: () => this.#capabilities?.canReadTraceText ?? null,
      canRead: (source) => this.#canRead(source),
      ...(this.#host?.kind === 'demo' ? { metadataPageSize: 5000, blobPageSize: 1000, asyncLookbackMs: 30 * 86_400_000 } : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  }

  async syncNow(): Promise<void> {
    if (!this.#store || !this.#transport || this.#status.syncing || this.#watchBusy) return;
    const run = async () => {
      this.#status.syncing = true;
      this.#status.progress = [];
      this.#status.error = null;
      this.#emit();
      const engine = this.#syncEngine((p: SyncProgress) => {
        const i = this.#status.progress.findIndex((x) => x.source === p.source);
        if (i >= 0) this.#status.progress[i] = p;
        else this.#status.progress.push(p);
        this.#emit();
      });
      try {
        // Show executions as soon as they arrive; jobs, steps and trace text follow.
        await engine.syncTraceLogs();
        await this.#reload();
        this.#emit();
        await engine.syncAsyncOperations();
        await engine.syncSteps();
        await this.#reload();
        this.#emit();
        await engine.syncFlowRuns();
        await engine.syncFlowEvents();
        await engine.syncProcesses();
        await this.#reload();
        this.#emit();
        await engine.syncTraceBlobs();
        await this.#reload();
        this.#status.lastSyncAt = this.clock();
        this.#channel?.postMessage('data-changed');
      } catch (e) {
        this.#status.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.#status.syncing = false;
        this.#emit();
      }
    };
    // Only one tab per environment syncs at a time; the others get a broadcast when it's done.
    if (this.#host?.kind === 'environment' && typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(`dataverse-trace-sync:${this.#host.envKey}`, { ifAvailable: true }, async (lock) => {
        if (lock) await run();
      });
    } else {
      await run();
    }
  }

  async forget(): Promise<void> {
    if (!this.#store || !this.#host) return;
    if (this.#timer) clearInterval(this.#timer);
    await this.#store.destroy();
    this.#store = new LocalStore(this.#host.kind === 'demo' ? 'demo' : this.#host.envKey);
    await this.#reload();
    this.#emit();
    void this.syncNow();
    if (this.#host.kind === 'environment') this.#timer = setInterval(() => void this.syncNow(), SYNC_INTERVAL_MS);
  }

  // ── queries ────────────────────────────────────────────────────────────────

  #now(): number {
    return this.clock();
  }

  async #ensureTextCache(): Promise<void> {
    if (this.#textCache || !this.#store) return;
    const cache = new Map<string, string>();
    let chars = 0;
    let limited = false;
    await this.#store.eachBlob((blob) => {
      if (!blob.messageBlock) return;
      if (chars + blob.messageBlock.length > TEXT_CACHE_LIMIT) {
        limited = true;
        return;
      }
      chars += blob.messageBlock.length;
      cache.set(blob.id, blob.messageBlock.toLowerCase());
    });
    this.#textCache = cache;
    this.#textCacheLimited = limited;
  }

  async query(q: LogQuery): Promise<LogQueryResult> {
    const started = performance.now();
    const hasText = parseQuery(q.text).text.length > 0;
    if (hasText) await this.#ensureTextCache();
    const out = explore(this.#data, q, this.#now(), (id) => this.#textCache?.get(id));
    const queryId = this.#nextQueryId++;
    this.#queries.set(queryId, out.rows);
    for (const id of [...this.#queries.keys()].slice(0, -MAX_CACHED_QUERIES)) this.#queries.delete(id);
    const oldest = out.matched.length ? out.matched[out.matched.length - 1]!.start : this.#now() - 3_600_000;
    return {
      queryId,
      total: out.rows.length,
      matchedExecutions: out.matched.length,
      parseErrors: out.parseErrors,
      histogram: histogram(out.matched, out.from ?? oldest, out.to),
      facets: facets(out.matched),
      from: out.from,
      to: out.to,
      textSearchLimited: hasText && this.#textCacheLimited,
      tookMs: Math.round(performance.now() - started),
    };
  }

  async rows(queryId: number, start: number, end: number): Promise<ExplorerRow[]> {
    return this.#queries.get(queryId)?.slice(start, end) ?? [];
  }

  async operationExecutions(correlationId: string) {
    return [...(this.#data.logsByCorrelation.get(correlationId) ?? [])].sort((a, b) => a.start - b.start || a.depth - b.depth);
  }

  async execution(id: string): Promise<ExecutionDetail | null> {
    const log = this.#data.logsById.get(id);
    if (!log) return null;
    const blob = (await this.#store?.blob(id)) ?? null;
    const step = log.stepId ? (this.#data.steps.get(log.stepId) ?? null) : null;
    const job =
      log.mode === 'async' && log.correlationId
        ? ((this.#data.jobsByCorrelation.get(log.correlationId) ?? []).find((j) => j.stepId && j.stepId === log.stepId) ?? null)
        : null;
    return { log, blob, step, job, operationSize: log.correlationId ? (this.#data.logsByCorrelation.get(log.correlationId)?.length ?? 1) : 1 };
  }

  async trace(correlationId: string): Promise<TraceView | null> {
    const traceLogs = this.#data.logsByCorrelation.get(correlationId) ?? [];
    const asyncOps = this.#data.jobsByCorrelation.get(correlationId) ?? [];
    const trace = assembleTrace(correlationId, { traceLogs, asyncOps, steps: this.#data.steps, now: this.#now() });
    if (!trace) return null;
    const steps: Record<string, StepRegistration> = {};
    for (const s of trace.spans) if (s.stepId && this.#data.steps.has(s.stepId)) steps[s.stepId] = this.#data.steps.get(s.stepId)!;
    return { trace, layout: layoutWaterfall(trace), steps };
  }

  async dashboard(range: RangeKey): Promise<DashboardData> {
    const gaps = this.#status.sources.find((s) => s.source === 'traceLogs')?.gaps ?? [];
    return dashboard(this.#data, range, this.#now(), this.#capabilities, gaps);
  }

  // ── v0.2: records ──────────────────────────────────────────────────────────

  #metadataFor(table: string): Promise<EntityMetadata> {
    let m = this.#metadata.get(table);
    if (!m) {
      m = fetchEntityMetadata(this.#transport!, table);
      m.catch(() => this.#metadata.delete(table));
      this.#metadata.set(table, m);
    }
    return m;
  }

  async #recordInfo(table: string, id: string): Promise<RecordInfo> {
    try {
      const metadata = await this.#metadataFor(table);
      const record = await fetchRecord(this.#transport!, metadata, id);
      return { table, id, name: record.name, values: record.values, error: null };
    } catch (e) {
      const known = [...this.#recent.values()].find((r) => r.id === id.toLowerCase());
      return { table, id, name: known?.name ?? null, values: null, error: message(e) };
    }
  }

  #remember(record: { table: string; id: string; name?: string | null }, source: RecentRecord['source']): void {
    const key = `${record.table}:${record.id}`.toLowerCase();
    const existing = this.#recent.get(key);
    this.#recent.set(key, { table: record.table, id: record.id.toLowerCase(), name: record.name ?? existing?.name ?? null, lastSeen: this.clock(), source });
  }

  async recentRecords(limit = 30): Promise<RecentRecord[]> {
    const byKey = new Map<string, RecentRecord>();
    for (const j of this.#data.jobs) {
      if (!j.regarding) continue;
      const key = `${j.regarding.table}:${j.regarding.id}`.toLowerCase();
      const seen = byKey.get(key);
      if (!seen || seen.lastSeen < j.createdOn) {
        byKey.set(key, { table: j.regarding.table, id: j.regarding.id.toLowerCase(), name: j.regarding.name ?? null, lastSeen: j.createdOn, source: 'systemJob' });
      }
    }
    for (const [key, r] of this.#recent) byKey.set(key, r);
    return [...byKey.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit);
  }

  async searchRecords(table: string, text: string): Promise<RecentRecord[]> {
    const metadata = await this.#metadataFor(table);
    const rows = await searchRecords(this.#transport!, metadata, text);
    return rows.map((r) => ({ ...r, id: r.id.toLowerCase(), lastSeen: this.clock(), source: 'search' as const }));
  }

  async knownTables(): Promise<string[]> {
    const tables = new Set<string>();
    for (const s of this.#data.steps.values()) if (s.primaryEntity && s.primaryEntity !== 'none') tables.add(s.primaryEntity);
    for (const p of this.#data.processes) {
      if (p.primaryEntity) tables.add(p.primaryEntity);
      if (p.flowTrigger) tables.add(p.flowTrigger.table);
    }
    for (const op of this.#data.operations.values()) for (const t of op.tables) if (t !== 'none') tables.add(t);
    return [...tables].sort();
  }

  async #readAudits(id: string): Promise<{ audits: AuditRecord[]; audit: RecordSaves['audit']; note: string | null }> {
    const caps = this.#capabilities;
    if (caps && !caps.canReadAudit) {
      return { audits: [], audit: 'unreadable', note: "You can't read audit history, so saves are found only through system jobs regarding this record." };
    }
    try {
      const audits = await fetchAudits(this.#transport!, id, { top: 100, withDetails: 20 });
      if (!audits.length && caps?.settings.isAuditEnabled === false) {
        return { audits, audit: 'off', note: 'Auditing is off for this environment, so saves are found only through system jobs regarding this record.' };
      }
      return { audits, audit: 'ok', note: null };
    } catch (e) {
      return { audits: [], audit: 'error', note: `Couldn't read audit history (${message(e)}).` };
    }
  }

  #saves(record: RecordRef, audits: readonly AuditRecord[]): SaveEvent[] {
    return findSaves({ record, audits, traceLogs: this.#data.logs, asyncOps: this.#data.jobs });
  }

  async recordSaves(table: string, id: string): Promise<RecordSaves> {
    const key = `${table}:${id}`.toLowerCase();
    const [record, audit] = await Promise.all([this.#recordInfo(table, id), this.#readAudits(id)]);
    this.#audits.set(key, audit.audits);
    this.#remember({ table, id, name: record.name }, this.#recent.get(key)?.source ?? 'search');
    const ref: RecordRef = { table, id, ...(record.name ? { name: record.name } : {}) };
    return { record, saves: this.#saves(ref, audit.audits), audit: audit.audit, auditNote: audit.note };
  }

  /** Steps registered for a table and change: read on demand, or from synced steps when that fails. */
  async #registeredSteps(table: string, change: ChangeKind): Promise<{ steps: StepRegistration[]; note: string | null }> {
    const key = `${table}|${change}`;
    let p = this.#stepsFor.get(key);
    if (!p) {
      p = fetchStepsForTable(this.#transport!, table, change);
      this.#stepsFor.set(key, p);
      setTimeout(() => this.#stepsFor.delete(key), 10 * MINUTE);
    }
    try {
      return { steps: await p, note: null };
    } catch (e) {
      this.#stepsFor.delete(key);
      const known = [...this.#data.steps.values()].filter((s) => s.primaryEntity === table && s.messageName?.toLowerCase() === change);
      return { steps: known, note: `Couldn't read the step registrations (${message(e)}); showing steps seen in local history only.` };
    }
  }

  async expected(request: ExpectedRequest): Promise<ExpectedResult> {
    const { steps, note } = await this.#registeredSteps(request.table, request.change);
    const items = expectedFor({
      table: request.table,
      change: request.change,
      changedColumns: request.changedColumns,
      steps,
      processes: this.#data.processes,
      ...(request.recordValues ? { recordValues: request.recordValues } : {}),
    });
    const processNote = this.#capabilities?.canReadProcesses === false ? "You can't read processes, so flows and workflows aren't listed." : null;
    const columns = new Set<string>();
    for (const st of steps) for (const c of st.filteringAttributes ?? []) columns.add(c);
    for (const p of this.#data.processes) {
      if (p.flowTrigger?.table === request.table) for (const c of p.flowTrigger.filteringAttributes ?? []) columns.add(c);
      if (p.primaryEntity === request.table) for (const c of p.triggerOnUpdateAttributes ?? []) columns.add(c);
    }
    return { items, note: [note, processNote].filter(Boolean).join(' ') || null, columns: [...columns].sort() };
  }

  async #storyView(record: RecordRef, info: RecordInfo | null, audits: readonly AuditRecord[], save: SaveEvent): Promise<RecordStoryView> {
    const t = save.time;
    const logs = this.#data.logsBetween(t - 10 * MINUTE, t + 30 * MINUTE);
    const jobs = this.#data.jobs.filter((j) => j.createdOn >= t - 10 * MINUTE && j.createdOn <= t + 60 * MINUTE);
    const runs = this.#data.flowRunsBetween(t - MINUTE, t + 60 * MINUTE);
    const story = buildRecordStory(save, {
      record,
      audits,
      saves: this.#saves(record, audits),
      traceLogs: logs,
      asyncOps: jobs,
      flowRuns: runs,
      processes: this.#data.processes,
      steps: this.#data.steps,
      ...(info?.values ? { recordValues: info.values } : {}),
      now: this.clock(),
    });
    const steps: Record<string, StepRegistration> = {};
    for (const s of story.trace.spans) if (s.stepId && this.#data.steps.has(s.stepId)) steps[s.stepId] = this.#data.steps.get(s.stepId)!;

    let expected: RecordStoryView['expected'] = [];
    let expectedNote: string | null = null;
    if (save.change !== 'other') {
      const registered = await this.#registeredSteps(record.table, save.change);
      const ranSteps = new Map<string, string[]>();
      const activations = new Set<string>();
      for (const span of story.trace.spans) {
        if (span.stepId) ranSteps.set(span.stepId, [...(ranSteps.get(span.stepId) ?? []), span.id]);
        if (span.source?.table === 'asyncoperation') {
          const job = this.#data.jobsById.get(span.source.id);
          if (job?.workflowId) activations.add(job.workflowId.toLowerCase());
        }
      }
      const observed: Observed = {
        steps: ranSteps,
        workflowActivationIds: activations,
        flows: new Map(story.flows.filter((f) => f.spanId).map((f) => [f.processId, { spanId: f.spanId!, confidence: f.confidence ?? 0 }])),
        traceSetting: this.#capabilities?.settings.pluginTraceLogSetting ?? null,
      };
      expected = expectedFor({
        table: record.table,
        change: save.change,
        changedColumns: save.changedColumns,
        steps: registered.steps,
        processes: this.#data.processes,
        recordValues: { ...(info?.values ?? {}), ...(save.newValues ?? {}) },
        observed,
      });
      expectedNote = registered.note;
    }
    return { story, layout: layoutWaterfall(story.trace), steps, expected, expectedNote };
  }

  async recordStory(table: string, id: string, saveId: string): Promise<RecordStoryView | null> {
    const key = `${table}:${id}`.toLowerCase();
    let audits = this.#audits.get(key);
    if (!audits) audits = (await this.#readAudits(id)).audits;
    const info = await this.#recordInfo(table, id);
    const record: RecordRef = { table, id, ...(info.name ? { name: info.name } : {}) };
    let save = this.#saves(record, audits).find((s) => s.id === saveId);
    if (!save) return null;
    if (save.auditIds.length && save.changedColumns === null) {
      // Older saves don't have their changed columns yet: read them now.
      const wanted = new Set(save.auditIds);
      const detailed = await fetchAuditDetails(this.#transport!, audits.filter((a) => wanted.has(a.id)));
      const byId = new Map(detailed.map((a) => [a.id, a]));
      audits = audits.map((a) => byId.get(a.id) ?? a);
      this.#audits.set(key, audits);
      save = this.#saves(record, audits).find((s) => s.id === saveId) ?? save;
    }
    return this.#storyView(record, info, audits, save);
  }

  async exportContext(spanIds: string[]): Promise<ExportContext> {
    const texts: Record<string, string> = {};
    const users = new Set<string>();
    for (const spanId of spanIds) {
      const [table, id] = spanId.split(':') as [string, string | undefined];
      if (table !== 'plugintracelog' || !id) continue;
      const log = this.#data.logsById.get(id);
      if (log?.createdByName) users.add(log.createdByName);
      const blob = await this.#store?.blob(id);
      if (blob?.messageBlock) texts[spanId] = blob.messageBlock;
    }
    return { texts, users: [...users] };
  }

  // ── v0.2: watch mode ───────────────────────────────────────────────────────

  /** Puts back a trace setting that a watch session switched and couldn't restore (tab closed, crash). */
  async #restorePending(): Promise<void> {
    if (this.#host?.kind !== 'environment' || !this.#store) return;
    const pending = await this.#store.getMeta<PendingRestore | null>(PENDING_RESTORE);
    if (!pending) return;
    try {
      await setTraceSetting(this.#transport!, pending.organizationId, pending.value);
      await this.#store.setMeta(PENDING_RESTORE, null);
      if (this.#capabilities) this.#capabilities.settings.pluginTraceLogSetting = pending.value;
      this.#status.watch.note = `The plug-in trace setting was put back to ${TRACE_LABELS[pending.value]} (a watch session switched it and didn't finish).`;
    } catch (e) {
      this.#status.watch.error = `A watch session switched the plug-in trace setting to All and it couldn't be put back to ${TRACE_LABELS[pending.value]}: ${message(e)}. Please change it back in the Power Platform admin center.`;
    }
  }

  async watchStart(table: string, id: string, options: { switchTrace: boolean; name?: string | null }): Promise<void> {
    if (!this.#transport || !this.#store || this.#status.watch.phase === 'watching') return;
    const now = this.clock();
    const recentName = [...this.#recent.values()].find((r) => r.id === id.toLowerCase())?.name;
    const known = { name: options.name ?? recentName ?? null };
    const watch: WatchStatus = {
      ...idleWatch(this.#host?.kind === 'demo'),
      phase: 'watching',
      record: { table, id: id.toLowerCase(), ...(known.name ? { name: known.name } : {}) },
      startedAt: now,
      idleStopAt: now + WATCH_IDLE_MS,
    };
    this.#status.watch = watch;
    this.#remember({ table, id, name: known.name ?? null }, 'watch');
    this.#audits.delete(`${table}:${id}`.toLowerCase());
    if (options.switchTrace) {
      try {
        if (this.#capabilities?.isSystemAdministrator !== true) throw new Error('Only System Administrators can change the trace setting.');
        const org = await fetchOrganization(this.#transport);
        if (org.traceSetting !== null && org.traceSetting !== 2) {
          // Write the marker first: if anything goes wrong from here on, the next start restores it.
          await this.#store.setMeta(PENDING_RESTORE, { organizationId: org.id, value: org.traceSetting, at: now } satisfies PendingRestore);
          await setTraceSetting(this.#transport, org.id, 2);
          this.#watchOrgId = org.id;
          watch.traceSwitch = { from: org.traceSetting, organizationId: org.id, restored: false };
          if (this.#capabilities) this.#capabilities.settings.pluginTraceLogSetting = 2;
        }
      } catch (e) {
        watch.error = `Couldn't switch the trace setting: ${message(e)}`;
      }
    }
    this.#emit();
    this.#watchTimer = setInterval(() => void this.#watchTick(), WATCH_POLL_MS);
  }

  async #watchTick(): Promise<void> {
    const watch = this.#status.watch;
    if (this.#watchBusy || watch.phase !== 'watching' || this.#status.syncing) return;
    this.#watchBusy = true;
    try {
      const fingerprint = () => {
        let modified = 0;
        for (const j of this.#data.jobs) if (j.modifiedOn > modified) modified = j.modifiedOn;
        return `${this.#data.logs.length}|${this.#data.jobs.length}|${this.#data.flowRuns.length}|${modified}`;
      };
      const before = fingerprint();
      const engine = this.#syncEngine();
      await engine.syncTraceLogs();
      await engine.syncAsyncOperations();
      watch.requests += 2;
      if (watch.polls % 3 === 0) watch.requests++;
      const key = `${watch.record!.table}:${watch.record!.id}`;
      let auditsChanged = false;
      if (watch.polls % 3 === 0) {
        // Flow runs, trace text and audit are read every third poll, which keeps watch under 2 requests a second.
        await engine.syncFlowRuns();
        await engine.syncTraceBlobs();
        watch.requests++;
        if (this.#capabilities?.canReadAudit !== false) {
          // Only saves made while watching need their changed columns.
          const rows = await fetchAudits(this.#transport!, watch.record!.id, { top: 10, withDetails: 0 });
          const previous = new Map((this.#audits.get(key) ?? []).map((a) => [a.id, a]));
          const merged = rows.map((a) => previous.get(a.id) ?? a);
          const missing = merged.filter((a) => a.changedColumns === null && a.createdOn >= watch.startedAt! - 2000);
          const detailed = new Map((await fetchAuditDetails(this.#transport!, missing)).map((a) => [a.id, a]));
          auditsChanged = merged.some((a) => !previous.has(a.id));
          this.#audits.set(key, merged.map((a) => detailed.get(a.id) ?? a));
          watch.requests += 1 + missing.length;
        }
      }
      await this.#reload();
      watch.polls++;
      const now = this.clock();
      if (auditsChanged || fingerprint() !== before) {
        watch.lastNewAt = now;
        watch.idleStopAt = now + WATCH_IDLE_MS;
      }
      if (now >= (watch.idleStopAt ?? now)) await this.#stopWatch('idle');
      else if (now - watch.startedAt! > WATCH_MAX_MS) await this.#stopWatch('limit');
    } catch (e) {
      watch.error = message(e);
    } finally {
      this.#watchBusy = false;
      this.#emit();
    }
  }

  async #stopWatch(reason: NonNullable<WatchStatus['stopReason']>): Promise<void> {
    const watch = this.#status.watch;
    if (watch.phase !== 'watching') return;
    if (this.#watchTimer) clearInterval(this.#watchTimer);
    this.#watchTimer = null;
    watch.phase = 'idle';
    watch.stoppedAt = this.clock();
    watch.idleStopAt = null;
    watch.stopReason = reason;
    if (watch.traceSwitch && !watch.traceSwitch.restored && this.#watchOrgId) {
      try {
        await setTraceSetting(this.#transport!, this.#watchOrgId, watch.traceSwitch.from);
        await this.#store!.setMeta(PENDING_RESTORE, null);
        watch.traceSwitch.restored = true;
        if (this.#capabilities) this.#capabilities.settings.pluginTraceLogSetting = watch.traceSwitch.from;
        watch.note = `The plug-in trace setting was put back to ${TRACE_LABELS[watch.traceSwitch.from]}.`;
      } catch (e) {
        watch.error = `Couldn't put the trace setting back to ${TRACE_LABELS[watch.traceSwitch.from]} (${message(e)}). The app will try again when it next starts.`;
      }
    }
    this.#emit();
  }

  async watchStop(): Promise<void> {
    // Let a poll in flight finish, so the restore isn't raced by it.
    while (this.#watchBusy) await new Promise((r) => setTimeout(r, 50));
    await this.#stopWatch('user');
  }

  async watchView(): Promise<WatchView> {
    const watch = this.#status.watch;
    if (!watch.record || watch.startedAt === null) return { saves: [], view: null, expected: null };
    const { table, id } = watch.record;
    const audits = this.#audits.get(`${table}:${id}`) ?? [];
    const saves = this.#saves(watch.record, audits).filter((s) => s.time >= watch.startedAt! - 2000);
    const expected = await this.expected({ table, change: 'update', changedColumns: null });
    const latest = saves[0];
    const view = latest ? await this.#storyView(watch.record, null, audits, latest) : null;
    return { saves, view, expected };
  }

  async simulateSave(): Promise<string | null> {
    if (!this.#demo || this.#host?.kind !== 'demo') return 'Simulated saves are only available in the demo.';
    const watch = this.#status.watch;
    if (watch.record && watch.record.table !== 'hbr_policy') return 'The simulation changes a policy: watch a policy record (hbr_policy) to see it.';
    const { simulateSave } = await import('@dvt/demo');
    const save = simulateSave(this.#demo, { now: this.clock(), ...(watch.record ? { recordId: watch.record.id } : {}) });
    (this.#transport as MockTransport).schedule(save);
    return null;
  }
}
