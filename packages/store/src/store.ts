// Local history: one IndexedDB database per environment. Raw records are the source of truth;
// spans and statistics are always derived from them, so improving the correlation rules never
// needs a re-fetch.
import {
  buildRollups,
  hourOf,
  HOUR_MS,
  newSnapshots,
  snapshotKey,
  type AsyncOperationRecord,
  type FlowEventRecord,
  type FlowRunRecord,
  type PluginTypeStatRecord,
  type PluginTypeStatSnapshot,
  type ProcessDefinition,
  type StepHourRollup,
  type StepRegistration,
  type TraceBlob,
  type TraceLogRecord,
} from '@dvt/core';
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
  flowRuns!: Table<FlowRunRecord, string>;
  flowEvents!: Table<FlowEventRecord, string>;
  processes!: Table<ProcessDefinition, string>;
  rollups!: Table<StepHourRollup, string>;
  pluginStats!: Table<PluginTypeStatSnapshot, string>;

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
    // v0.2: cloud flow runs, flow events (gap signals) and process definitions.
    this.version(2).stores({
      flowRuns: 'id, start, modifiedOn, workflowId, runId, parentRunId',
      flowEvents: 'id, createdOn',
      processes: 'id',
    });
    // v0.3: hourly per-step rollups, which outlive raw rows (built from the rows already stored),
    // and snapshots of the platform's plug-in type statistics.
    this.version(3)
      .stores({ rollups: 'id, hour', pluginStats: 'key, takenAt, modifiedOn' })
      .upgrade(async (tx) => {
        const logs = (await tx.table('traceLogs').toArray()) as TraceLogRecord[];
        await tx.table('rollups').bulkPut(buildRollups(logs));
      });
  }
}

/** How long each kind of data is kept locally. */
export interface Retention {
  /** Trace logs, system jobs, flow runs and flow events. */
  rawMs: number;
  /** Trace text. */
  blobsMs: number;
  rollupsMs: number;
}

export const DEFAULT_RETENTION: Retention = { rawMs: 30 * 86_400_000, blobsMs: 14 * 86_400_000, rollupsMs: 400 * 86_400_000 };

/** Meta key: raw trace logs are complete from this time on (older ones were pruned). */
export const RAW_FROM = 'rawFrom';

export interface PruneResult {
  traceLogs: number;
  traceBlobs: number;
  asyncOps: number;
  flowRuns: number;
  rollups: number;
}

export interface StorageSummary {
  traceLogs: number;
  traceBlobs: number;
  asyncOps: number;
  steps: number;
  flowRuns: number;
  processes: number;
  rollups: number;
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
    await this.db.transaction('rw', this.db.traceLogs, this.db.rollups, async () => {
      const existing = await this.db.traceLogs.bulkGet(rows.map((r) => r.id));
      const merged = rows.map((r, i) => {
        const known = existing[i]?.messageBlockLength;
        return known !== null && known !== undefined && r.messageBlockLength === null ? { ...r, messageBlockLength: known } : r;
      });
      await this.db.traceLogs.bulkPut(merged);
      await this.#refreshRollups(merged.map((r) => r.start).concat(existing.flatMap((r) => (r ? [r.start] : []))));
    });
  }

  /** Rebuilds the rollups of the hours containing `times` from the raw rows stored for them. */
  async #refreshRollups(times: number[]): Promise<void> {
    const hours = [...new Set(times.map(hourOf))];
    for (const hour of hours) {
      const logs = await this.db.traceLogs.where('start').between(hour, hour + HOUR_MS, true, false).toArray();
      await this.db.rollups.where('hour').equals(hour).delete();
      await this.db.rollups.bulkPut(buildRollups(logs));
    }
  }

  /** Stores trace text and records its length on the matching trace log rows. */
  async putTraceBlobs(rows: TraceBlob[]): Promise<void> {
    await this.db.transaction('rw', this.db.traceBlobs, this.db.traceLogs, this.db.rollups, async () => {
      await this.db.traceBlobs.bulkPut(rows);
      const logs = await this.db.traceLogs.bulkGet(rows.map((r) => r.id));
      const updated = logs
        .map((log, i): TraceLogRecord | undefined => (log ? { ...log, messageBlockLength: rows[i]!.messageBlock?.length ?? 0 } : undefined))
        .filter((l): l is TraceLogRecord => l !== undefined);
      await this.db.traceLogs.bulkPut(updated);
      // Rollups count truncated trace text, which is only known once the text arrives.
      await this.#refreshRollups(updated.map((l) => l.start));
    });
  }

  async putAsyncOperations(rows: AsyncOperationRecord[]): Promise<void> {
    await this.db.asyncOps.bulkPut(rows);
  }

  async putSteps(rows: StepRegistration[]): Promise<void> {
    await this.db.steps.bulkPut(rows);
  }

  async putFlowRuns(rows: FlowRunRecord[]): Promise<void> {
    await this.db.flowRuns.bulkPut(rows);
  }

  async putFlowEvents(rows: FlowEventRecord[]): Promise<void> {
    await this.db.flowEvents.bulkPut(rows);
  }

  async putPluginStats(rows: PluginTypeStatRecord[], takenAt: number): Promise<number> {
    return this.db.transaction('rw', this.db.pluginStats, async () => {
      const keys = rows.map(snapshotKey);
      const existing = await this.db.pluginStats.bulkGet(keys);
      const known = new Set(keys.filter((_, i) => existing[i] !== undefined));
      const fresh = newSnapshots(rows, known, takenAt);
      await this.db.pluginStats.bulkPut(fresh);
      return fresh.length;
    });
  }

  async replaceProcesses(rows: ProcessDefinition[]): Promise<void> {
    await this.db.transaction('rw', this.db.processes, async () => {
      await this.db.processes.clear();
      await this.db.processes.bulkPut(rows);
    });
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

  allFlowRuns(): Promise<FlowRunRecord[]> {
    return this.db.flowRuns.toArray();
  }

  allFlowEvents(): Promise<FlowEventRecord[]> {
    return this.db.flowEvents.toArray();
  }

  allProcesses(): Promise<ProcessDefinition[]> {
    return this.db.processes.toArray();
  }

  /** Rollups of hours in [from, to), oldest first. */
  rollupsBetween(from: number, to: number): Promise<StepHourRollup[]> {
    return this.db.rollups.where('hour').between(from, to, true, false).sortBy('hour');
  }

  async oldestRollupHour(): Promise<number | null> {
    return (await this.db.rollups.orderBy('hour').first())?.hour ?? null;
  }

  allPluginStats(): Promise<PluginTypeStatSnapshot[]> {
    return this.db.pluginStats.toArray();
  }

  /** Stores snapshots directly (the demo's earlier refreshes). */
  async putPluginStatSnapshots(rows: PluginTypeStatSnapshot[]): Promise<void> {
    await this.db.pluginStats.bulkPut(rows);
  }

  /** Stores rollups directly: history imported without its raw rows (the demo's older weeks). */
  async putRollups(rows: StepHourRollup[]): Promise<void> {
    await this.db.rollups.bulkPut(rows);
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
    const [traceLogs, traceBlobs, asyncOps, steps, flowRuns, processes, rollups, oldest, newest] = await Promise.all([
      this.db.traceLogs.count(),
      this.db.traceBlobs.count(),
      this.db.asyncOps.count(),
      this.db.steps.count(),
      this.db.flowRuns.count(),
      this.db.processes.count(),
      this.db.rollups.count(),
      this.db.traceLogs.orderBy('start').first(),
      this.db.traceLogs.orderBy('start').last(),
    ]);
    return { traceLogs, traceBlobs, asyncOps, steps, flowRuns, processes, rollups, oldest: oldest?.start ?? null, newest: newest?.start ?? null };
  }

  /**
   * Applies the retention periods relative to `now`. Rollups aren't rebuilt when raw rows go, so
   * history stays summarised after its rows are deleted.
   */
  async prune(now: number, retention: Retention = DEFAULT_RETENTION): Promise<PruneResult> {
    const rawBefore = now - retention.rawMs;
    const blobsBefore = now - retention.blobsMs;
    const rollupsBefore = now - retention.rollupsMs;
    const db = this.db;
    return db.transaction('rw', [db.traceLogs, db.traceBlobs, db.asyncOps, db.flowRuns, db.flowEvents, db.rollups, db.pluginStats, db.meta], async () => {
      const oldIds = (await db.traceLogs.where('createdOn').below(rawBefore).primaryKeys()) as string[];
      await db.traceLogs.bulkDelete(oldIds);
      const oldTextIds = (await db.traceLogs.where('createdOn').below(blobsBefore).primaryKeys()) as string[];
      const blobIds = [...oldIds, ...oldTextIds];
      const existingBlobs = (await db.traceBlobs.bulkGet(blobIds)).filter((b) => b !== undefined).length;
      await db.traceBlobs.bulkDelete(blobIds);
      const asyncOps = await db.asyncOps.where('modifiedOn').below(rawBefore).delete();
      const flowRuns = await db.flowRuns.where('modifiedOn').below(rawBefore).delete();
      await db.flowEvents.where('createdOn').below(rawBefore).delete();
      const rollups = await db.rollups.where('hour').below(rollupsBefore).delete();
      // Statistic snapshots are small and summarise history too, so they're kept as long as rollups.
      await db.pluginStats.where('takenAt').below(rollupsBefore).delete();
      if (oldIds.length > 0) {
        const previous = ((await db.meta.get(RAW_FROM))?.value as number | undefined) ?? -Infinity;
        await db.meta.put({ key: RAW_FROM, value: Math.max(previous, rawBefore) });
      }
      return { traceLogs: oldIds.length, traceBlobs: existingBlobs, asyncOps, flowRuns, rollups };
    });
  }

  /** Deletes the whole local database for this environment. */
  async destroy(): Promise<void> {
    this.db.close();
    await this.db.delete();
  }
}
