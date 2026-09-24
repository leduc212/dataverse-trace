// Raw Web API rows → typed records. The only place that knows column names and annotation keys.
import type {
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
