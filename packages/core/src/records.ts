// Typed source records. `packages/dataverse` maps raw Web API rows into these; everything else in the
// app works on these types, never on raw OData JSON.

/** Epoch milliseconds (UTC). */
export type EpochMs = number;

/** Sub-second precision of timestamps from a source. The Web API returns whole seconds (spike S1). */
export type TimePrecision = 'ms' | 's';

export type ExecutionMode = 'sync' | 'async';

export type TraceOperationType = 'plugin' | 'workflowActivity' | 'unknown';

/** One `plugintracelog` row (without the large text columns, which live in {@link TraceBlob}). */
export interface TraceLogRecord {
  id: string;
  correlationId: string | null;
  requestId: string | null;
  stepId: string | null;
  typeName: string;
  messageName: string;
  /** Table logical name, e.g. `account`. `null` for messages without a primary table. */
  primaryEntity: string | null;
  mode: ExecutionMode;
  operationType: TraceOperationType;
  depth: number;
  /** `performanceexecutionstarttime`. */
  start: EpochMs;
  durationMs: number;
  constructorMs: number | null;
  createdOn: EpochMs;
  createdById: string | null;
  createdByName: string | null;
  /** Exception text, if the step threw. */
  exception: string | null;
  /** Length of `messageblock` in characters, or `null` when unreadable/not fetched. */
  messageBlockLength: number | null;
  precision: TimePrecision;
}

/** Trace text and configuration for a trace log row, fetched and stored separately. */
export interface TraceBlob {
  id: string;
  /** `null` when the column came back null (for example, the user isn't System Administrator). */
  messageBlock: string | null;
}

export interface RecordRef {
  table: string;
  id: string;
  name?: string;
}

/** One `asyncoperation` (system job) row. */
export interface AsyncOperationRecord {
  id: string;
  name: string;
  correlationId: string | null;
  requestId: string | null;
  /** `operationtype` code, e.g. 1 System Event (async plugin), 10 Workflow. */
  operationType: number;
  operationTypeLabel: string;
  /** `statuscode`: 0 Waiting for resources, 10 Waiting, 20 In progress, 21 Pausing, 22 Canceling, 30 Succeeded, 31 Failed, 32 Canceled. */
  statusCode: number;
  statusLabel: string;
  depth: number | null;
  /** `owningextensionid` → the plugin step, for async plugin jobs. */
  stepId: string | null;
  /** `workflowactivationid` → the workflow, for workflow jobs. */
  workflowId: string | null;
  regarding: RecordRef | null;
  primaryEntity: string | null;
  messageName: string | null;
  createdOn: EpochMs;
  startedOn: EpochMs | null;
  completedOn: EpochMs | null;
  modifiedOn: EpochMs;
  retryCount: number;
  errorCode: number | null;
  message: string | null;
  precision: TimePrecision;
}

/** Plugin step stage values used in execution order. */
export const STAGES = { preValidation: 10, preOperation: 20, mainOperation: 30, postOperation: 40 } as const;
export type Stage = 10 | 20 | 30 | 40;

/** One `sdkmessageprocessingstep`, flattened with its message, filter and plugin type. */
export interface StepRegistration {
  id: string;
  name: string;
  stage: Stage;
  mode: ExecutionMode;
  rank: number;
  /** `null` = fires on any column (no filtering attributes). */
  filteringAttributes: string[] | null;
  messageName: string | null;
  primaryEntity: string | null;
  pluginTypeName: string | null;
  assemblyName: string | null;
  enabled: boolean;
  asyncAutoDelete: boolean;
  impersonatingUserId: string | null;
  isManaged: boolean;
}

/** `organization` settings the app cares about. */
export interface OrganizationSettings {
  /** 0 Off, 1 Exceptions, 2 All; `null` when unreadable. */
  pluginTraceLogSetting: 0 | 1 | 2 | null;
  isAuditEnabled: boolean | null;
  maxUploadFileSize: number | null;
}

export const TRACE_SETTING_LABELS = { 0: 'Off', 1: 'Exceptions', 2: 'All' } as const;
