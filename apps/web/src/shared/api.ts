// The contract between the UI (main thread) and the worker, which owns all data work: syncing,
// storage, filtering, correlation and statistics. Everything crossing it must be structured-cloneable.
import type {
  AsyncOperationRecord,
  ChangeKind,
  ExpectedItem,
  Heatmap,
  Kpis,
  OperationSummary,
  RecordRef,
  RecordStory,
  SaveEvent,
  StepRegistration,
  StepStats,
  TimeBucket,
  Trace,
  TraceBlob,
  TraceLogRecord,
  WaterfallLayout,
} from '@dvt/core';
import type { Capabilities, SourceState, SyncProgress } from '@dvt/dataverse';
import type { StorageSummary } from '@dvt/store';

export type HostInfo =
  | { kind: 'environment'; origin: string; envKey: string }
  | { kind: 'demo' };

export interface Status {
  host: HostInfo | null;
  /** True once local data has been loaded (the first sync may still be running). */
  ready: boolean;
  capabilities: Capabilities | null;
  sources: SourceState[];
  storage: StorageSummary | null;
  syncing: boolean;
  progress: SyncProgress[];
  lastSyncAt: number | null;
  throttledUntil: number | null;
  error: string | null;
  /** Increases whenever the loaded data changes, so views know to refresh. */
  dataVersion: number;
  watch: WatchStatus;
}

// ── v0.2: record story, expected vs. actual, watch mode ─────────────────────

export interface RecordInfo {
  table: string;
  id: string;
  name: string | null;
  /** Current column values, or null when the record couldn't be read. */
  values: Record<string, unknown> | null;
  /** Why the record couldn't be read (deleted, no access, unknown table). */
  error: string | null;
}

export interface RecentRecord {
  table: string;
  id: string;
  name: string | null;
  lastSeen: number;
  source: 'systemJob' | 'watch' | 'search';
}

export interface RecordSaves {
  record: RecordInfo;
  /** Newest first. */
  saves: SaveEvent[];
  /** How audit history could be read. */
  audit: 'ok' | 'unreadable' | 'off' | 'error';
  auditNote: string | null;
}

export interface RecordStoryView {
  story: RecordStory;
  layout: WaterfallLayout;
  steps: Record<string, StepRegistration>;
  expected: ExpectedItem[];
  expectedNote: string | null;
}

export interface ExpectedRequest {
  table: string;
  change: ChangeKind;
  /** null = not known (every filtered step is "unknown"). */
  changedColumns: string[] | null;
  /** Current values for flow filter expressions. */
  recordValues?: Record<string, unknown>;
}

export interface ExpectedResult {
  items: ExpectedItem[];
  note: string | null;
  /** Columns that decide whether something runs (filtering attributes, trigger columns). */
  columns: string[];
}

export interface WatchStatus {
  phase: 'idle' | 'watching';
  record: RecordRef | null;
  startedAt: number | null;
  stoppedAt: number | null;
  /** When new rows last arrived. */
  lastNewAt: number | null;
  /** Watch stops by itself at this time unless new rows arrive. */
  idleStopAt: number | null;
  polls: number;
  requests: number;
  /** Set when the trace setting was switched to All for the session. */
  traceSwitch: { from: 0 | 1 | 2; organizationId: string; restored: boolean } | null;
  stopReason: 'user' | 'idle' | 'limit' | null;
  /** Informational message, e.g. about restoring the trace setting. */
  note: string | null;
  error: string | null;
  /** Demo: simulated saves are available. */
  canSimulate: boolean;
}

export interface WatchView {
  /** Saves of the watched record since the watch started (newest first). */
  saves: SaveEvent[];
  /** The newest save's story, once one is seen. */
  view: RecordStoryView | null;
  /** What's registered to run on update of this table (ghosts before a save arrives). */
  expected: ExpectedResult | null;
}

export interface ExportContext {
  /** Trace text by span id. */
  texts: Record<string, string>;
  /** Names of users that appear in the trace rows (for redaction). */
  users: string[];
}

export type RangeKey = '1h' | '24h' | '7d' | '30d' | 'all';
export type ExplorerView = 'operations' | 'executions';
export type SortKey = 'newest' | 'oldest' | 'slowest';

export interface LogQuery {
  text: string;
  range: RangeKey;
  view: ExplorerView;
  sort: SortKey;
}

export interface HistogramBucket {
  start: number;
  end: number;
  ok: number;
  errors: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface Facets {
  typeName: FacetValue[];
  messageName: FacetValue[];
  primaryEntity: FacetValue[];
  mode: FacetValue[];
  depth: FacetValue[];
}

export interface LogQueryResult {
  queryId: number;
  /** Rows in the current view (operations or executions). */
  total: number;
  matchedExecutions: number;
  parseErrors: string[];
  histogram: HistogramBucket[];
  facets: Facets;
  from: number | null;
  to: number;
  /** True when trace text was too large to search in full. */
  textSearchLimited: boolean;
  tookMs: number;
}

export type ExplorerRow =
  | { kind: 'operation'; op: OperationSummary; matched: number }
  | { kind: 'execution'; log: TraceLogRecord };

export interface ExecutionDetail {
  log: TraceLogRecord;
  blob: TraceBlob | null;
  step: StepRegistration | null;
  job: AsyncOperationRecord | null;
  operationSize: number;
}

export interface TraceView {
  trace: Trace;
  layout: WaterfallLayout;
  steps: Record<string, StepRegistration>;
}

export interface Finding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  /** Explorer query that shows the evidence. */
  query?: string;
}

export interface DashboardStep extends StepStats {
  /** Executions per bucket across the range (for a sparkline). */
  spark: number[];
  stepName: string | null;
  stage: number | null;
  filteringAttributes: string[] | null | undefined;
}

export interface DashboardData {
  range: RangeKey;
  from: number;
  to: number;
  bucketMs: number;
  kpis: Kpis;
  series: TimeBucket[];
  heatmap: Heatmap;
  steps: DashboardStep[];
  findings: Finding[];
  gaps: Array<[number, number]>;
  /** Earliest execution held locally. */
  oldest: number | null;
}

export interface WorkerApi {
  init(host: HostInfo): Promise<void>;
  subscribe(listener: (status: Status) => void): void;
  getStatus(): Promise<Status>;
  syncNow(): Promise<void>;
  query(q: LogQuery): Promise<LogQueryResult>;
  rows(queryId: number, start: number, end: number): Promise<ExplorerRow[]>;
  operationExecutions(correlationId: string): Promise<TraceLogRecord[]>;
  execution(id: string): Promise<ExecutionDetail | null>;
  trace(correlationId: string): Promise<TraceView | null>;
  dashboard(range: RangeKey): Promise<DashboardData>;
  forget(): Promise<void>;
  // v0.2
  recentRecords(limit?: number): Promise<RecentRecord[]>;
  searchRecords(table: string, text: string): Promise<RecentRecord[]>;
  knownTables(): Promise<string[]>;
  recordSaves(table: string, id: string): Promise<RecordSaves>;
  recordStory(table: string, id: string, saveId: string): Promise<RecordStoryView | null>;
  expected(request: ExpectedRequest): Promise<ExpectedResult>;
  watchStart(table: string, id: string, options: { switchTrace: boolean; name?: string | null }): Promise<void>;
  watchStop(): Promise<void>;
  watchView(): Promise<WatchView>;
  simulateSave(): Promise<string | null>;
  exportContext(spanIds: string[]): Promise<ExportContext>;
}

export const RANGE_MS: Record<RangeKey, number | null> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  all: null,
};

export const RANGE_LABELS: Record<RangeKey, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All history',
};
