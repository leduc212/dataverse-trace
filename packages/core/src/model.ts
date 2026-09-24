// The normalised span model. Every source becomes spans; the timeline, dashboard and exports all
// work on spans. Maps cleanly onto OpenTelemetry (traceKey → trace id, childOf → parent span).
import type { EpochMs, ExecutionMode, RecordRef, Stage, TimePrecision } from './records.ts';

export type SpanKind =
  | 'request' // synthetic: one message pipeline (same correlationId + requestId)
  | 'plugin' // plugintracelog, operation type Plug-in
  | 'workflowActivity' // plugintracelog, operation type Workflow Activity
  | 'systemJob' // asyncoperation
  | 'flowRun'
  | 'audit'
  | 'expected'
  | 'mark';

export type SpanStatus = 'ok' | 'error' | 'running' | 'waiting' | 'canceled' | 'expected' | 'notFired';

/** Which lane of the waterfall a span belongs to. */
export type Lane = 'sync' | 'async' | 'flow' | 'audit';

export interface SpanError {
  message: string;
  exceptionType?: string;
  code?: string;
}

export interface Span {
  id: string;
  traceKey: string;
  kind: SpanKind;
  name: string;
  source: { table: string; id: string } | null;
  lane: Lane;
  start: EpochMs;
  /** `undefined` while running. */
  end?: EpochMs;
  /** System jobs: when the job was created (queue time = start − queuedAt). */
  queuedAt?: EpochMs;
  precision: TimePrecision;
  status: SpanStatus;
  depth?: number;
  mode?: ExecutionMode;
  stage?: Stage;
  rank?: number;
  message?: string;
  table?: string;
  record?: RecordRef & { exact: boolean };
  correlationId?: string;
  requestId?: string;
  stepId?: string;
  metrics: { durationMs?: number; constructorMs?: number; queueMs?: number; retries?: number };
  error?: SpanError;
  attrs: Record<string, string | number | boolean>;
}

export type LinkType = 'childOf' | 'followsFrom' | 'triggeredBy' | 'sameRecord' | 'sameTransaction';

export interface Evidence {
  label: string;
  weight: number;
}

export interface SpanLink {
  /** Parent / cause. */
  from: string;
  /** Child / effect. */
  to: string;
  type: LinkType;
  /** 1 = exact. */
  confidence: number;
  rule: string;
  evidence: Evidence[];
}

export type CaveatCode =
  | 'secondPrecision'
  | 'ambiguousNesting'
  | 'asyncJobMissing'
  | 'traceTextUnreadable'
  | 'tracingOff'
  | 'tracingExceptionsOnly'
  | 'noOperationFound'
  | 'inferredFlows'
  | 'columnsUnknown'
  | 'flowDataIncomplete';

export interface Caveat {
  code: CaveatCode;
  message: string;
}

export interface TraceSummary {
  start: EpochMs;
  end: EpochMs;
  wallMs: number;
  /** Sum of sync pipeline time (inside the transaction). */
  syncMs: number;
  errors: number;
  maxDepth: number;
  counts: Partial<Record<SpanKind, number>>;
  /** First depth-1 request, e.g. "Update account". */
  title: string;
}

export interface Trace {
  key: string;
  anchor?: RecordRef & { exact: boolean };
  spans: Span[];
  links: SpanLink[];
  caveats: Caveat[];
  summary: TraceSummary;
}
