// Raw Web API rows → typed records. The only place that knows column names and annotation keys.
import { parseFlowTrigger, toSubscription, type TriggerSubscription } from '@dvt/core';
import type {
  AuditRecord,
  FlowEventRecord,
  FlowRunRecord,
  ProcessCategory,
  ProcessDefinition,
  AsyncOperationRecord,
  RecordRef,
  Stage,
  StepRegistration,
  TimePrecision,
  TraceBlob,
  TraceLogRecord,
  TraceOperationType,
} from '@dvt/core';

export type Raw = Record<string, unknown>;

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const LOOKUP_TABLE = '@Microsoft.Dynamics.CRM.lookuplogicalname';

export const formatted = (row: Raw, column: string): string | undefined => {
  const v = row[`${column}${FORMATTED}`];
  return typeof v === 'string' ? v : undefined;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parses an ISO timestamp; `null` for missing values. */
export function time(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Whole-second values have no fraction (spike S1: the Web API returns seconds). */
export const precisionOf = (...values: unknown[]): TimePrecision =>
  values.some((v) => typeof v === 'string' && /T\d{2}:\d{2}:\d{2}\.\d+/.test(v)) ? 'ms' : 's';

function required<T>(value: T | null, what: string, row: Raw): T {
  if (value === null) throw new Error(`Row is missing ${what}: ${JSON.stringify(row).slice(0, 200)}`);
  return value;
}

const OPERATION_TYPES: Record<number, TraceOperationType> = { 1: 'plugin', 2: 'workflowActivity' };

export function mapTraceLog(row: Raw): TraceLogRecord {
  const start = required(time(row['performanceexecutionstarttime']) ?? time(row['createdon']), 'a start time', row);
  return {
    id: required(str(row['plugintracelogid']), 'plugintracelogid', row),
    correlationId: str(row['correlationid']),
    requestId: str(row['requestid']),
    stepId: str(row['pluginstepid']),
    typeName: str(row['typename']) ?? '(unknown type)',
    messageName: str(row['messagename']) ?? '',
    primaryEntity: str(row['primaryentity']) === 'none' ? null : str(row['primaryentity']),
    mode: row['mode'] === 1 ? 'async' : 'sync',
    operationType: OPERATION_TYPES[num(row['operationtype']) ?? 0] ?? 'unknown',
    depth: num(row['depth']) ?? 1,
    start,
    durationMs: num(row['performanceexecutionduration']) ?? 0,
    constructorMs: num(row['performanceconstructorduration']),
    createdOn: time(row['createdon']) ?? start,
    createdById: str(row['_createdby_value']),
    createdByName: formatted(row, '_createdby_value') ?? null,
    exception: str(row['exceptiondetails']),
    messageBlockLength: null,
    precision: precisionOf(row['performanceexecutionstarttime'], row['createdon']),
  };
}

export function mapTraceBlob(row: Raw): TraceBlob {
  return { id: required(str(row['plugintracelogid']), 'plugintracelogid', row), messageBlock: typeof row['messageblock'] === 'string' ? row['messageblock'] : null };
}

export function mapAsyncOperation(row: Raw): AsyncOperationRecord {
  const regardingId = str(row['_regardingobjectid_value']);
  const regardingTable = str(row[`_regardingobjectid_value${LOOKUP_TABLE}`]);
  let regarding: RecordRef | null = null;
  if (regardingId && regardingTable) {
    regarding = { table: regardingTable, id: regardingId };
    const name = formatted(row, '_regardingobjectid_value');
    if (name) regarding.name = name;
  }
  const createdOn = required(time(row['createdon']), 'createdon', row);
  const operationType = num(row['operationtype']) ?? 0;
  const statusCode = num(row['statuscode']) ?? 0;
  return {
    id: required(str(row['asyncoperationid']), 'asyncoperationid', row),
    name: str(row['name']) ?? '',
    correlationId: str(row['correlationid']),
    requestId: str(row['requestid']),
    operationType,
    operationTypeLabel: formatted(row, 'operationtype') ?? String(operationType),
    statusCode,
    statusLabel: formatted(row, 'statuscode') ?? String(statusCode),
    depth: num(row['depth']),
    stepId: str(row['_owningextensionid_value']),
    workflowId: str(row['_workflowactivationid_value']),
    regarding,
    primaryEntity: str(row['primaryentitytype']),
    messageName: str(row['messagename']),
    createdOn,
    startedOn: time(row['startedon']),
    completedOn: time(row['completedon']),
    modifiedOn: time(row['modifiedon']) ?? createdOn,
    retryCount: num(row['retrycount']) ?? 0,
    errorCode: num(row['errorcode']),
    message: str(row['friendlymessage']) ?? str(row['message']),
    precision: precisionOf(row['createdon'], row['startedon'], row['completedon']),
  };
}

const STAGE_VALUES: ReadonlySet<number> = new Set([10, 20, 30, 40]);

export function mapStep(row: Raw): StepRegistration {
  const message = row['sdkmessageid'] as Raw | null | undefined;
  const filter = row['sdkmessagefilterid'] as Raw | null | undefined;
  const pluginType = row['plugintypeid'] as Raw | null | undefined;
  const stage = num(row['stage']) ?? 40;
  const filtering = str(row['filteringattributes'])
    ?.split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const primary = filter ? str(filter['primaryobjecttypecode']) : null;
  return {
    id: required(str(row['sdkmessageprocessingstepid']), 'sdkmessageprocessingstepid', row),
    name: str(row['name']) ?? '',
    stage: (STAGE_VALUES.has(stage) ? stage : 40) as Stage,
    mode: row['mode'] === 1 ? 'async' : 'sync',
    rank: num(row['rank']) ?? 1,
    filteringAttributes: filtering && filtering.length > 0 ? filtering : null,
    messageName: message ? str(message['name']) : null,
    primaryEntity: primary === 'none' ? null : primary,
    pluginTypeName: pluginType ? str(pluginType['typename']) : null,
    assemblyName: pluginType ? str(pluginType['assemblyname']) : null,
    enabled: row['statecode'] === 0,
    asyncAutoDelete: row['asyncautodelete'] === true,
    impersonatingUserId: str(row['_impersonatinguserid_value']),
    isManaged: row['ismanaged'] === true,
  };
}

// ── v0.2: flows, processes, audit ────────────────────────────────────────────

function flowStatus(raw: string | null): FlowRunRecord['status'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'succeeded':
    case 'success':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'running':
    case 'waiting':
      return 'running';
    default:
      return 'other';
  }
}

export function mapFlowRun(row: Raw): FlowRunRecord {
  const start = required(time(row['starttime']) ?? time(row['createdon']), 'starttime', row);
  const statusLabel = str(row['status']) ?? 'Unknown';
  const end = time(row['endtime']);
  return {
    id: required(str(row['flowrunid']), 'flowrunid', row),
    runId: str(row['name']) ?? '',
    workflowId: str(row['_workflow_value']) ?? str(row['workflowid']),
    flowName: formatted(row, '_workflow_value') ?? null,
    start,
    end,
    durationMs: num(row['duration']) ?? (end !== null ? end - start : null),
    status: flowStatus(statusLabel),
    statusLabel,
    triggerType: str(row['triggertype']),
    errorCode: str(row['errorcode']),
    errorMessage: str(row['errormessage']),
    parentRunId: str(row['parentrunid']),
    createdOn: time(row['createdon']) ?? start,
    modifiedOn: time(row['modifiedon']) ?? start,
    ownerId: str(row['_ownerid_value']),
    ownerName: formatted(row, '_ownerid_value') ?? null,
    precision: precisionOf(row['starttime'], row['endtime']),
  };
}

export function mapFlowEvent(row: Raw): FlowEventRecord {
  return {
    id: required(str(row['floweventid']), 'floweventid', row),
    eventType: str(row['eventtype']) ?? '',
    eventCode: str(row['eventcode']) ?? '',
    level: str(row['level']),
    name: str(row['name']),
    createdOn: required(time(row['createdon']), 'createdon', row),
    parentObjectId: str(row['_parentobjectid_value']),
  };
}

const CATEGORIES: Record<number, ProcessCategory> = { 0: 'workflow', 2: 'businessRule', 5: 'flow' };

/**
 * Turns workflow rows into process definitions: activation rows (type 2) are folded into their
 * definition's `activationIds`, and flow definitions get their parsed trigger from `clientdata`.
 */
export function mapProcesses(rows: readonly Raw[], clientdata: ReadonlyMap<string, unknown>): ProcessDefinition[] {
  const definitions = new Map<string, ProcessDefinition>();
  const activations: Array<{ id: string; parent: string | null }> = [];
  for (const row of rows) {
    const id = str(row['workflowid']);
    if (!id) continue;
    if (row['type'] === 2) {
      activations.push({ id, parent: str(row['_parentworkflowid_value']) });
      continue;
    }
    const categoryCode = num(row['category']) ?? -1;
    const category = CATEGORIES[categoryCode] ?? 'other';
    const mode = num(row['mode']);
    const updateList = str(row['triggeronupdateattributelist'])
      ?.split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    const primary = str(row['primaryentity']);
    definitions.set(id.toLowerCase(), {
      id,
      name: str(row['name']) ?? '(unnamed process)',
      category,
      categoryCode,
      active: row['statecode'] === 1,
      primaryEntity: primary && primary !== 'none' ? primary.toLowerCase() : null,
      mode: category === 'workflow' ? (mode === 1 ? 'realtime' : 'background') : null,
      scope: num(row['scope']),
      triggerOnCreate: row['triggeroncreate'] === true,
      triggerOnDelete: row['triggerondelete'] === true,
      triggerOnUpdateAttributes: updateList && updateList.length ? updateList : null,
      activationIds: [],
      flowTrigger: category === 'flow' ? parseFlowTrigger(clientdata.get(id.toLowerCase()) ?? null) : null,
      modifiedOn: time(row['modifiedon']) ?? 0,
    });
  }
  for (const a of activations) {
    const parent = a.parent ? definitions.get(a.parent.toLowerCase()) : undefined;
    if (parent) parent.activationIds.push(a.id);
  }
  // A definition id also identifies it in system jobs of some workflows.
  for (const d of definitions.values()) if (d.category === 'workflow') d.activationIds.push(d.id);
  return [...definitions.values()];
}

const AUDIT_OPERATIONS: Record<number, AuditRecord['operation']> = { 1: 'create', 2: 'update', 3: 'delete' };

export function mapAudit(row: Raw): AuditRecord {
  const createdOn = required(time(row['createdon']), 'createdon', row);
  const action = num(row['action']) ?? 0;
  return {
    id: required(str(row['auditid']), 'auditid', row),
    table: str(row['objecttypecode']) ?? '',
    recordId: required(str(row['_objectid_value']), '_objectid_value', row),
    operation: AUDIT_OPERATIONS[num(row['operation']) ?? 0] ?? 'other',
    action,
    actionLabel: formatted(row, 'action') ?? String(action),
    createdOn,
    userId: str(row['_userid_value']),
    userName: formatted(row, '_userid_value') ?? null,
    transactionId: str(row['transactionid']),
    changedColumns: null,
    newValues: null,
    precision: precisionOf(row['createdon']),
  };
}

/**
 * Changed columns and new values from a RetrieveAuditDetails response. Lookups come back as
 * `_x_value`; they're reported by column name (`x`). Annotations are dropped.
 */
export function auditChanges(response: Raw): { changedColumns: string[]; newValues: Record<string, unknown> } {
  const detail = (response['AuditDetail'] ?? {}) as Raw;
  const clean = (values: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!values || typeof values !== 'object') return out;
    for (const [key, value] of Object.entries(values as Raw)) {
      if (key.includes('@')) continue;
      const lookup = /^_(.+)_value$/.exec(key);
      out[lookup ? lookup[1]! : key] = value;
    }
    return out;
  };
  const oldValues = clean(detail['OldValue']);
  const newValues = clean(detail['NewValue']);
  const changedColumns = [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])].sort();
  return { changedColumns, newValues };
}

/** A `callbackregistration` row as a trigger subscription, or null when it isn't a row trigger. */
export function mapCallbackRegistration(row: Raw): TriggerSubscription | null {
  return toSubscription(row['entityname'], row['message'], row['filteringattributes'], row['filterexpression']);
}
