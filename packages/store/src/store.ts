// Local history: one IndexedDB database per environment. Raw records are the source of truth;
// spans and statistics are always derived from them, so improving the correlation rules never
// needs a re-fetch.
import type { AsyncOperationRecord, StepRegistration, TraceBlob, TraceLogRecord } from '@dvt/core';
import type { SourceName, SourceState, SyncStore } from '@dvt/dataverse';
import { Dexie, type Table } from 'dexie';

export interface MetaEntry {
  key: string;
  value: unknown;
}

class TraceDb extends Dexie {
  traceLogs!: Table<TraceLogRecord, string>;
  traceBlobs!: Table<TraceBlob, string>;
  asyncOps!: Table<AsyncOperationRecord, string>;
  steps!: Table<StepRegistration, string>;
  sourceState!: Table<SourceState, SourceName>;
  meta!: Table<MetaEntry, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      traceLogs: 'id, createdOn, start, correlationId, stepId',
      traceBlobs: 'id',
      asyncOps: 'id, correlationId, modifiedOn, stepId',
      steps: 'id',
      sourceState: 'source',
      meta: 'key',
    });
  }
}

export interface StorageSummary {
  traceLogs: number;
  traceBlobs: number;
  asyncOps: number;
  steps: number;
  oldest: number | null;
  newest: number | null;
}

/** Database name for an environment. `envKey` is the environment host, or "demo". */
export const databaseName = (envKey: string) => `dataverse-trace:${envKey.toLowerCase()}`;

export class LocalStore implements SyncStore {
  readonly db: TraceDb;

  constructor(envKey: string) {
    this.db = new TraceDb(databaseName(envKey));
  }

  // ── SyncStore ──────────────────────────────────────────────────────────────

  getSourceState(source: SourceName): Promise<SourceState | undefined> {
    return this.db.sourceState.get(source);
  }

  async putSourceState(state: SourceState): Promise<void> {
    await this.db.sourceState.put(state);
  }

  /** Upserts, keeping the trace-text length already known for rows that are re-read. */
  async putTraceLogs(rows: TraceLogRecord[]): Promise<void> {
    await this.db.transaction('rw', this.db.traceLogs, async () => {
      const existing = await this.db.traceLogs.bulkGet(rows.map((r) => r.id));
      const merged = rows.map((r, i) => {
        const known = existing[i]?.messageBlockLength;
        return known !== null && known !== undefined && r.messageBlockLength === null ? { ...r, messageBlockLength: known } : r;
      });
      await this.db.traceLogs.bulkPut(merged);
    });
  }

  /** Stores trace text and records its length on the matching trace log rows. */
  async putTraceBlobs(rows: TraceBlob[]): Promise<void> {
    await this.db.transaction('rw', this.db.traceBlobs, this.db.traceLogs, async () => {
      await this.db.traceBlobs.bulkPut(rows);
      const logs = await this.db.traceLogs.bulkGet(rows.map((r) => r.id));
      const updated = logs
        .map((log, i): TraceLogRecord | undefined => (log ? { ...log, messageBlockLength: rows[i]!.messageBlock?.length ?? 0 } : undefined))
        .filter((l): l is TraceLogRecord => l !== undefined);
      await this.db.traceLogs.bulkPut(updated);
    });
  }

  async putAsyncOperations(rows: AsyncOperationRecord[]): Promise<void> {
    await this.db.asyncOps.bulkPut(rows);
  }

  async putSteps(rows: StepRegistration[]): Promise<void> {
    await this.db.steps.bulkPut(rows);
  }

  async referencedStepIds(): Promise<Set<string>> {
    const [fromLogs, fromJobs] = await Promise.all([
      this.db.traceLogs.orderBy('stepId').uniqueKeys(),
      this.db.asyncOps.orderBy('stepId').uniqueKeys(),
    ]);
    return new Set([...fromLogs, ...fromJobs].filter((k): k is string => typeof k === 'string' && k !== ''));
  }

  async knownStepIds(): Promise<Set<string>> {
    return new Set((await this.db.steps.toCollection().primaryKeys()) as string[]);
  }

  // ── reads for the app ──────────────────────────────────────────────────────

  allTraceLogs(): Promise<TraceLogRecord[]> {
    return this.db.traceLogs.toArray();
  }

  allAsyncOperations(): Promise<AsyncOperationRecord[]> {
    return this.db.asyncOps.toArray();
  }

  allSteps(): Promise<StepRegistration[]> {
    return this.db.steps.toArray();
  }

  traceLogsByCorrelation(correlationId: string): Promise<TraceLogRecord[]> {
    return this.db.traceLogs.where('correlationId').equals(correlationId).toArray();
  }

  asyncOperationsByCorrelation(correlationId: string): Promise<AsyncOperationRecord[]> {
    return this.db.asyncOps.where('correlationId').equals(correlationId).toArray();
  }

  async blob(id: string): Promise<TraceBlob | undefined> {
    return this.db.traceBlobs.get(id);
  }

  /** Streams every stored trace text; used by full-text search. */
  async eachBlob(visit: (blob: TraceBlob) => void): Promise<void> {
    await this.db.traceBlobs.each(visit);
  }

  allSourceStates(): Promise<SourceState[]> {
    return this.db.sourceState.toArray();
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  async summary(): Promise<StorageSummary> {
    const [traceLogs, traceBlobs, asyncOps, steps, oldest, newest] = await Promise.all([
      this.db.traceLogs.count(),
      this.db.traceBlobs.count(),
      this.db.asyncOps.count(),
      this.db.steps.count(),
      this.db.traceLogs.orderBy('start').first(),
      this.db.traceLogs.orderBy('start').last(),
    ]);
    return { traceLogs, traceBlobs, asyncOps, steps, oldest: oldest?.start ?? null, newest: newest?.start ?? null };
  }

  /** Deletes trace logs (and their text) created before `before`, and system jobs last modified before it. */
  async prune(before: number): Promise<{ traceLogs: number; asyncOps: number }> {
    return this.db.transaction('rw', this.db.traceLogs, this.db.traceBlobs, this.db.asyncOps, async () => {
      const oldIds = (await this.db.traceLogs.where('createdOn').below(before).primaryKeys()) as string[];
      await this.db.traceLogs.bulkDelete(oldIds);
      await this.db.traceBlobs.bulkDelete(oldIds);
      const asyncOps = await this.db.asyncOps.where('modifiedOn').below(before).delete();
      return { traceLogs: oldIds.length, asyncOps };
    });
  }

  /** Deletes the whole local database for this environment. */
  async destroy(): Promise<void> {
    this.db.close();
    await this.db.delete();
  }
}
