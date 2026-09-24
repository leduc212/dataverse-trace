// Incremental sync from Dataverse into local storage.
//
//  traceLogs  – metadata, incremental on createdon (inclusive, deduplicated by id on write)
//  steps      – registrations for step ids seen in trace logs and system jobs, refreshed every 6 h
//  asyncOps   – incremental on modifiedon (jobs change state after they're created), 7-day lookback
//  traceBlobs – trace text in a separate, slower lane; skipped when the user can't read it
//
// The platform deletes trace logs older than ~24 h. If more than 24 h passed since the last
// successful trace-log sync, the gap is recorded so charts can shade it instead of showing a dip.
import type { AsyncOperationRecord, StepRegistration, TraceBlob, TraceLogRecord } from '@dvt/core';
import { mapAsyncOperation, mapStep, mapTraceBlob, mapTraceLog, type Raw } from './mappers.ts';
import { asyncOperationsQuery, stepsByIdQuery, traceBlobsQuery, traceLogsQuery } from './queries.ts';
import { pages, type Transport } from './transport.ts';

export type SourceName = 'traceLogs' | 'steps' | 'asyncOps' | 'traceBlobs';

export interface SourceState {
  source: SourceName;
  watermark: number | null;
  lastRunAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** Time ranges that may be missing data, as [from, to] epoch ms. */
  gaps: Array<[number, number]>;
  /** When this source was first synced successfully. */
  firstOkAt: number | null;
}

export interface SyncStore {
  getSourceState(source: SourceName): Promise<SourceState | undefined>;
  putSourceState(state: SourceState): Promise<void>;
  putTraceLogs(rows: TraceLogRecord[]): Promise<void>;
  putTraceBlobs(rows: TraceBlob[]): Promise<void>;
  putAsyncOperations(rows: AsyncOperationRecord[]): Promise<void>;
  putSteps(rows: StepRegistration[]): Promise<void>;
  /** Step ids referenced by stored trace logs and system jobs. */
  referencedStepIds(): Promise<Set<string>>;
  knownStepIds(): Promise<Set<string>>;
}

export interface SyncProgress {
  source: SourceName;
  phase: 'running' | 'done' | 'skipped' | 'error';
  fetched: number;
  message?: string;
}

export interface SyncReport {
  startedAt: number;
  finishedAt: number;
  results: SyncProgress[];
}

export interface SyncOptions {
  transport: Transport;
  store: SyncStore;
  /** Whether trace text can be read (from the capability probe). `false` skips the blob lane. */
  canReadTraceText?: () => boolean | null;
  now?: () => number;
  onProgress?: (p: SyncProgress) => void;
  asyncLookbackMs?: number;
  metadataPageSize?: number;
  blobPageSize?: number;
}

export const DAY_MS = 86_400_000;
const SERVER_RETENTION_MS = DAY_MS;
const STEP_REFRESH_MS = 6 * 3_600_000;
const STEP_BATCH = 40;

/** Adds a gap, merging it with any gap it overlaps or touches. */
export function addGap(gaps: Array<[number, number]>, gap: [number, number]): Array<[number, number]> {
  if (gap[1] <= gap[0]) return gaps;
  const all = [...gaps, gap].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of all) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

const emptyState = (source: SourceName): SourceState => ({
  source,
  watermark: null,
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  gaps: [],
  firstOkAt: null,
});

export class SyncEngine {
  readonly #o: Required<Omit<SyncOptions, 'onProgress' | 'canReadTraceText'>> & Pick<SyncOptions, 'onProgress' | 'canReadTraceText'>;

  constructor(options: SyncOptions) {
    this.#o = {
      now: Date.now,
      asyncLookbackMs: 7 * DAY_MS,
      metadataPageSize: 2000,
      blobPageSize: 200,
      ...options,
    };
  }

  #emit(p: SyncProgress) {
    this.#o.onProgress?.(p);
  }

  async #run(source: SourceName, work: (state: SourceState, progress: (n: number) => void) => Promise<number | 'skipped'>): Promise<SyncProgress> {
    const { store, now } = this.#o;
    const state = (await store.getSourceState(source)) ?? emptyState(source);
    state.lastRunAt = now();
    let fetched = 0;
    const progress = (n: number) => {
      fetched += n;
      this.#emit({ source, phase: 'running', fetched });
    };
    this.#emit({ source, phase: 'running', fetched: 0 });
    try {
      const outcome = await work(state, progress);
      if (outcome === 'skipped') {
        const p: SyncProgress = { source, phase: 'skipped', fetched: 0 };
        this.#emit(p);
        return p;
      }
      state.lastOkAt = state.lastRunAt;
      state.firstOkAt ??= state.lastRunAt;
      state.lastError = null;
      await store.putSourceState(state);
      const p: SyncProgress = { source, phase: 'done', fetched };
      this.#emit(p);
      return p;
    } catch (e) {
      state.lastError = e instanceof Error ? e.message : String(e);
      await store.putSourceState(state);
      const p: SyncProgress = { source, phase: 'error', fetched, message: state.lastError };
      this.#emit(p);
      return p;
    }
  }

  syncTraceLogs(signal?: AbortSignal): Promise<SyncProgress> {
    return this.#run('traceLogs', async (state, progress) => {
      const { transport, store, now } = this.#o;
      if (state.lastOkAt !== null && now() - state.lastOkAt > SERVER_RETENTION_MS) {
        state.gaps = addGap(state.gaps, [state.lastOkAt, now() - SERVER_RETENTION_MS]);
      }
      const options = signal ? { maxPageSize: this.#o.metadataPageSize, signal } : { maxPageSize: this.#o.metadataPageSize };
      for await (const page of pages<Raw>(transport, traceLogsQuery(state.watermark), options)) {
        const rows = page.map(mapTraceLog);
        await store.putTraceLogs(rows);
        const maxCreated = Math.max(state.watermark ?? 0, ...rows.map((r) => r.createdOn));
        state.watermark = maxCreated;
        // Advance the watermark only after the page is saved, so an interrupted sync resumes.
        await store.putSourceState(state);
        progress(rows.length);
      }
      return 0;
    });
  }

  syncTraceBlobs(signal?: AbortSignal): Promise<SyncProgress> {
    return this.#run('traceBlobs', async (state, progress) => {
      if (this.#o.canReadTraceText?.() === false) return 'skipped';
      const { transport, store } = this.#o;
      const options = signal ? { maxPageSize: this.#o.blobPageSize, signal, annotations: false } : { maxPageSize: this.#o.blobPageSize, annotations: false };
      for await (const page of pages<Raw>(transport, traceBlobsQuery(state.watermark), options)) {
        await store.putTraceBlobs(page.map(mapTraceBlob));
        const created = page.map((r) => Date.parse(String(r['createdon']))).filter((t) => !Number.isNaN(t));
        if (created.length) state.watermark = Math.max(state.watermark ?? 0, ...created);
        await store.putSourceState(state);
        progress(page.length);
      }
      return 0;
    });
  }

  syncAsyncOperations(signal?: AbortSignal): Promise<SyncProgress> {
    return this.#run('asyncOps', async (state, progress) => {
      const { transport, store, now } = this.#o;
      const since = state.watermark ?? now() - this.#o.asyncLookbackMs;
      const options = signal ? { maxPageSize: this.#o.metadataPageSize, signal } : { maxPageSize: this.#o.metadataPageSize };
      for await (const page of pages<Raw>(transport, asyncOperationsQuery(since), options)) {
        const rows = page.map(mapAsyncOperation);
        await store.putAsyncOperations(rows);
        state.watermark = Math.max(state.watermark ?? since, ...rows.map((r) => r.modifiedOn));
        await store.putSourceState(state);
        progress(rows.length);
      }
      return 0;
    });
  }

  syncSteps(signal?: AbortSignal): Promise<SyncProgress> {
    return this.#run('steps', async (state, progress) => {
      const { transport, store, now } = this.#o;
      const referenced = await store.referencedStepIds();
      const known = await store.knownStepIds();
      const refreshAll = state.lastOkAt === null || now() - state.lastOkAt > STEP_REFRESH_MS;
      const wanted = [...referenced].filter((id) => refreshAll || !known.has(id)).sort();
      for (let i = 0; i < wanted.length; i += STEP_BATCH) {
        signal?.throwIfAborted();
        const batch = wanted.slice(i, i + STEP_BATCH);
        const rows: StepRegistration[] = [];
        const options = signal ? { signal } : {};
        for await (const page of pages<Raw>(transport, stepsByIdQuery(batch), options)) rows.push(...page.map(mapStep));
        await store.putSteps(rows);
        progress(rows.length);
      }
      return 0;
    });
  }

  /** Runs every source in dependency order. Errors in one source don't stop the others. */
  async syncAll(signal?: AbortSignal): Promise<SyncReport> {
    const startedAt = this.#o.now();
    const results: SyncProgress[] = [];
    results.push(await this.syncTraceLogs(signal));
    results.push(await this.syncAsyncOperations(signal));
    results.push(await this.syncSteps(signal));
    results.push(await this.syncTraceBlobs(signal));
    return { startedAt, finishedAt: this.#o.now(), results };
  }
}
