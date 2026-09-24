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

/**
 * One `plugintypestatistic` row: the platform's own counters for a plug-in type. They're kept even
 * when trace logging is off. The window they cover isn't documented (spike S8).
 */
export interface PluginTypeStatRecord {
  id: string;
  pluginTypeId: string | null;
  /** The plug-in type's name, usually its full .NET type name. */
  typeName: string | null;
  executeCount: number;
  failureCount: number;
  failurePercent: number | null;
  crashCount: number;
  crashPercent: number | null;
  crashContributionPercent: number | null;
  averageExecuteMs: number | null;
  terminateCpuPercent: number | null;
  terminateMemoryPercent: number | null;
  terminateHandlesPercent: number | null;
  terminateOtherPercent: number | null;
  /** When Dataverse last updated the counters. */
  modifiedOn: EpochMs;
}

/** A stored copy of a statistic row, kept each time Dataverse updates it. */
export interface PluginTypeStatSnapshot extends PluginTypeStatRecord {
  /** `${id}@${modifiedOn}`: one snapshot per update. */
  key: string;
  /** When the app first read this version. */
  takenAt: EpochMs;
}

/** One `flowrun` row (cloud flow run history in Dataverse). */
export interface FlowRunRecord {
  id: string;
  /** The run's own id (`name`), which child runs reference as `parentRunId`. */
  runId: string;
  workflowId: string | null;
  flowName: string | null;
  start: EpochMs;
  end: EpochMs | null;
  durationMs: number | null;
  /** Normalised from the `status` string. */
  status: 'succeeded' | 'failed' | 'cancelled' | 'running' | 'other';
  statusLabel: string;
  triggerType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  parentRunId: string | null;
  createdOn: EpochMs;
  modifiedOn: EpochMs;
  ownerId: string | null;
  ownerName: string | null;
  precision: TimePrecision;
}

/** One `flowevent` row: signals that flow run history may be incomplete. */
export interface FlowEventRecord {
  id: string;
  eventType: string;
  eventCode: string;
  level: string | null;
  name: string | null;
  createdOn: EpochMs;
  parentObjectId: string | null;
}

export type ChangeKind = 'create' | 'update' | 'delete';

/** A cloud flow's Dataverse trigger ("When a row is added, modified or deleted"). */
export interface FlowTrigger {
  table: string;
  changes: ChangeKind[];
  /** `null` = fires on any column. */
  filteringAttributes: string[] | null;
  /** OData `$filter` the row must match, or `null`. */
  filterExpression: string | null;
  /** 1 User, 2 Business unit, 3 Parent-child business units, 4 Organization. */
  scope: number | null;
  /** Trigger conditions (Logic Apps expressions). We can't evaluate these. */
  conditions: string[];
  delayed: boolean;
}

export type ProcessCategory = 'workflow' | 'businessRule' | 'flow' | 'other';

/** A classic workflow, business rule or cloud flow definition (`workflow` rows of type Definition). */
export interface ProcessDefinition {
  id: string;
  name: string;
  category: ProcessCategory;
  categoryCode: number;
  /** Activated (state 1). */
  active: boolean;
  primaryEntity: string | null;
  /** Classic workflows: background or real-time. */
  mode: 'background' | 'realtime' | null;
  scope: number | null;
  triggerOnCreate: boolean;
  triggerOnDelete: boolean;
  /** Classic workflows: columns that trigger it on update; `null` = not triggered by updates. */
  triggerOnUpdateAttributes: string[] | null;
  /** Classic workflows: ids of activation rows, which system jobs reference. */
  activationIds: string[];
  /** Cloud flows with a Dataverse trigger. */
  flowTrigger: FlowTrigger | null;
  /**
   * Cloud flows: whether a live trigger subscription (`callbackregistration`) matches the trigger.
   * Undefined or null = not checked (no read access, or not a flow).
   */
  subscription?: 'found' | 'missing' | null;
  modifiedOn: EpochMs;
}

/** One audited change of a record. `changedColumns` is `null` until the details are loaded. */
export interface AuditRecord {
  id: string;
  table: string;
  recordId: string;
  operation: ChangeKind | 'other';
  action: number;
  actionLabel: string;
  createdOn: EpochMs;
  userId: string | null;
  userName: string | null;
  transactionId: string | null;
  changedColumns: string[] | null;
  /** New values of the changed columns, when details are loaded. */
  newValues: Record<string, unknown> | null;
  precision: TimePrecision;
}
