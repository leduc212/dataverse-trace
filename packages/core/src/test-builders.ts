// Builders for tests. Not exported from the package index.
import type { AsyncOperationRecord, StepRegistration, TraceLogRecord } from './records.ts';

export const T0 = Date.UTC(2026, 8, 24, 8, 0, 0);

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${String(++counter).padStart(4, '0')}`;

export function traceLog(p: Partial<TraceLogRecord> = {}): TraceLogRecord {
  return {
    id: nextId('log'),
    correlationId: 'corr-1',
    requestId: 'req-1',
    stepId: null,
    typeName: 'Harbor.Plugins.Sample',
    messageName: 'Update',
    primaryEntity: 'account',
    mode: 'sync',
    operationType: 'plugin',
    depth: 1,
    start: T0,
    durationMs: 100,
    constructorMs: 2,
    createdOn: T0,
    createdById: null,
    createdByName: null,
    exception: null,
    messageBlockLength: null,
    precision: 'ms',
    ...p,
  };
}

export function asyncOp(p: Partial<AsyncOperationRecord> = {}): AsyncOperationRecord {
  return {
    id: nextId('job'),
    name: 'Harbor.Plugins.Notify',
    correlationId: 'corr-1',
    requestId: 'req-1',
    operationType: 1,
    operationTypeLabel: 'System Event',
    statusCode: 30,
    statusLabel: 'Succeeded',
    depth: 1,
    stepId: null,
    workflowId: null,
    regarding: null,
    primaryEntity: 'account',
    messageName: 'Update',
    createdOn: T0,
    startedOn: T0 + 2000,
    completedOn: T0 + 2500,
    modifiedOn: T0 + 2500,
    retryCount: 0,
    errorCode: null,
    message: null,
    precision: 'ms',
    ...p,
  };
}

export function step(p: Partial<StepRegistration> = {}): StepRegistration {
  return {
    id: nextId('step'),
    name: 'Sample step',
    stage: 40,
    mode: 'sync',
    rank: 1,
    filteringAttributes: null,
    messageName: 'Update',
    primaryEntity: 'account',
    pluginTypeName: 'Harbor.Plugins.Sample',
    assemblyName: 'Harbor.Plugins',
    enabled: true,
    asyncAutoDelete: false,
    impersonatingUserId: null,
    isManaged: false,
    ...p,
  };
}
