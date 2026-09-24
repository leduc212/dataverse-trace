// Implements the WorkerApi. Owns the store, the transport, the sync loop and the in-memory indexes.
import { assembleTrace, layoutWaterfall, parseQuery, type StepRegistration } from '@dvt/core';
import { FetchTransport, SyncEngine, probeCapabilities, type Capabilities, type SyncProgress, type Transport } from '@dvt/dataverse';
import { LocalStore } from '@dvt/store';
import type {
  DashboardData,
  ExecutionDetail,
  ExplorerRow,
  HostInfo,
  LogQuery,
  LogQueryResult,
  RangeKey,
  Status,
  TraceView,
  WorkerApi,
} from '../shared/api.ts';
import { Dataset } from './dataset.ts';
import { explore, facets, histogram } from './explore.ts';
import { dashboard } from './insights.ts';

const SYNC_INTERVAL_MS = 5 * 60_000;
/** Cap on trace text kept in memory for full-text search (characters). */
const TEXT_CACHE_LIMIT = 60_000_000;
const MAX_CACHED_QUERIES = 4;

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
  };
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
        this.#transport = new MockTransport(generateDemo());
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
    const [logs, jobs, steps, sources, storage] = await Promise.all([
      store.allTraceLogs(),
      store.allAsyncOperations(),
      store.allSteps(),
      store.allSourceStates(),
      store.summary(),
    ]);
    this.#data = new Dataset(logs, jobs, steps);
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

  async syncNow(): Promise<void> {
    if (!this.#store || !this.#transport || this.#status.syncing) return;
    const run = async () => {
      this.#status.syncing = true;
      this.#status.progress = [];
      this.#status.error = null;
      this.#emit();
      const engine = new SyncEngine({
        transport: this.#transport!,
        store: this.#store!,
        now: this.clock,
        canReadTraceText: () => this.#capabilities?.canReadTraceText ?? null,
        ...(this.#host?.kind === 'demo' ? { metadataPageSize: 5000, blobPageSize: 1000, asyncLookbackMs: 30 * 86_400_000 } : {}),
        onProgress: (p: SyncProgress) => {
          const i = this.#status.progress.findIndex((x) => x.source === p.source);
          if (i >= 0) this.#status.progress[i] = p;
          else this.#status.progress.push(p);
          this.#emit();
        },
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
}
