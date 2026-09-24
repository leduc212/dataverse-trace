// The contract between the UI (main thread) and the worker, which owns all data work: syncing,
// storage, filtering, correlation and statistics. Everything crossing it must be structured-cloneable.
import type {
  AsyncOperationRecord,
  Heatmap,
  Kpis,
  OperationSummary,
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
