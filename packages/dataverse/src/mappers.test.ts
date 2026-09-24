import { describe, expect, it } from 'vitest';
import { auditChanges, mapAsyncOperation, mapAudit, mapFlowEvent, mapFlowRun, mapProcesses, mapStep, mapTraceBlob, mapTraceLog, precisionOf } from './mappers.ts';
import { addGap } from './sync.ts';
import { stepsByIdQuery, traceLogsQuery } from './queries.ts';

const FV = '@OData.Community.Display.V1.FormattedValue';

describe('mapTraceLog', () => {
  const raw = {
    plugintracelogid: 'a1',
    correlationid: 'c1',
    requestid: 'r1',
    pluginstepid: 's1',
    typename: 'Harbor.Plugins.PolicyErpSync',
    messagename: 'Update',
    primaryentity: 'hbr_policy',
    mode: 0,
    operationtype: 1,
    depth: 2,
    performanceexecutionstarttime: '2026-09-24T08:13:56Z',
    performanceexecutionduration: 812,
    performanceconstructorduration: 41,
    exceptiondetails: null,
    createdon: '2026-09-24T08:13:57Z',
    _createdby_value: 'u1',
    [`_createdby_value${FV}`]: 'Jamie Ortiz',
  };

  it('maps columns, parses times and detects whole-second precision', () => {
    expect(mapTraceLog(raw)).toEqual({
      id: 'a1',
      correlationId: 'c1',
      requestId: 'r1',
      stepId: 's1',
      typeName: 'Harbor.Plugins.PolicyErpSync',
      messageName: 'Update',
      primaryEntity: 'hbr_policy',
      mode: 'sync',
      operationType: 'plugin',
      depth: 2,
      start: Date.parse('2026-09-24T08:13:56Z'),
      durationMs: 812,
      constructorMs: 41,
      createdOn: Date.parse('2026-09-24T08:13:57Z'),
      createdById: 'u1',
      createdByName: 'Jamie Ortiz',
      exception: null,
      messageBlockLength: null,
      precision: 's',
    });
  });

  it('handles async, workflow activities, "none" tables and millisecond timestamps', () => {
    const r = mapTraceLog({ ...raw, mode: 1, operationtype: 2, primaryentity: 'none', performanceexecutionstarttime: '2026-09-24T08:13:56.250Z' });
    expect(r).toMatchObject({ mode: 'async', operationType: 'workflowActivity', primaryEntity: null, precision: 'ms' });
  });

  it('rejects rows without an id', () => {
    expect(() => mapTraceLog({ ...raw, plugintracelogid: null })).toThrow('plugintracelogid');
  });
});

describe('other mappers', () => {
  it('maps system jobs with regarding, labels and step link', () => {
    const job = mapAsyncOperation({
      asyncoperationid: 'j1',
      name: 'Notify',
      correlationid: 'c1',
      requestid: 'r1',
      operationtype: 1,
      [`operationtype${FV}`]: 'System Event',
      statuscode: 31,
      [`statuscode${FV}`]: 'Failed',
      depth: 1,
      _owningextensionid_value: 's1',
      _regardingobjectid_value: 'p1',
      '_regardingobjectid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'hbr_policy',
      [`_regardingobjectid_value${FV}`]: 'HP-10442',
      createdon: '2026-09-24T08:00:00Z',
      startedon: '2026-09-24T08:00:05Z',
      completedon: null,
      modifiedon: '2026-09-24T08:00:05Z',
      retrycount: 2,
      friendlymessage: 'ERP down',
    });
    expect(job).toMatchObject({
      statusCode: 31,
      statusLabel: 'Failed',
      operationTypeLabel: 'System Event',
      stepId: 's1',
      regarding: { table: 'hbr_policy', id: 'p1', name: 'HP-10442' },
      startedOn: Date.parse('2026-09-24T08:00:05Z'),
      completedOn: null,
      retryCount: 2,
      message: 'ERP down',
      precision: 's',
    });
  });

  it('maps steps with expanded message, table and plugin type', () => {
    const s = mapStep({
      sdkmessageprocessingstepid: 's1',
      name: 'Erp',
      stage: 40,
      mode: 0,
      rank: 2,
      filteringattributes: 'hbr_premium, hbr_status',
      statecode: 0,
      asyncautodelete: false,
      ismanaged: false,
      sdkmessageid: { name: 'Update' },
      sdkmessagefilterid: { primaryobjecttypecode: 'hbr_policy' },
      plugintypeid: { typename: 'Harbor.Plugins.PolicyErpSync', assemblyname: 'Harbor.Plugins' },
    });
    expect(s).toMatchObject({ stage: 40, mode: 'sync', rank: 2, filteringAttributes: ['hbr_premium', 'hbr_status'], messageName: 'Update', primaryEntity: 'hbr_policy', enabled: true });
    expect(mapStep({ sdkmessageprocessingstepid: 's2', filteringattributes: '', stage: 5 })).toMatchObject({ filteringAttributes: null, stage: 40 });
  });

  it('maps blobs, keeping null when trace text is hidden', () => {
    expect(mapTraceBlob({ plugintracelogid: 'a', messageblock: null })).toEqual({ id: 'a', messageBlock: null });
  });

  it('detects precision from any value', () => {
    expect(precisionOf('2026-09-24T08:00:00Z', null)).toBe('s');
    expect(precisionOf('2026-09-24T08:00:00.000Z')).toBe('ms');
  });
});

describe('queries', () => {
  it('builds incremental trace log queries', () => {
    expect(traceLogsQuery(null)).not.toContain('$filter');
    expect(traceLogsQuery(Date.parse('2026-09-24T08:00:00Z'))).toContain('$filter=createdon ge 2026-09-24T08:00:00.000Z');
  });

  it('only puts valid GUIDs into step lookups', () => {
    const q = stepsByIdQuery(['11111111-2222-3333-4444-555555555555', "x') or true or ('"]);
    expect(q).toContain("PropertyValues=['11111111-2222-3333-4444-555555555555']");
    expect(() => stepsByIdQuery(['nope'])).toThrow();
  });
});

describe('addGap', () => {
  it('merges overlapping and touching gaps and ignores empty ones', () => {
    let gaps: Array<[number, number]> = [];
    gaps = addGap(gaps, [10, 20]);
    gaps = addGap(gaps, [15, 30]);
    gaps = addGap(gaps, [30, 35]);
    gaps = addGap(gaps, [50, 60]);
    gaps = addGap(gaps, [70, 70]);
    expect(gaps).toEqual([
      [10, 35],
      [50, 60],
    ]);
  });
});

describe('v0.2 mappers', () => {
  it('maps a flow run, with its status and whole-second precision', () => {
    const run = mapFlowRun({
      flowrunid: 'f1',
      name: '08584000000000000000CU12',
      starttime: '2026-09-24T08:14:03Z',
      endtime: '2026-09-24T08:14:12Z',
      duration: 9120,
      status: 'Failed',
      triggertype: 'Automated',
      errorcode: 'ActionFailed',
      errormessage: 'An action failed.',
      parentrunid: null,
      _workflow_value: 'w1',
      [`_workflow_value${FV}`]: 'Notify underwriter',
      createdon: '2026-09-24T08:15:40Z',
      modifiedon: '2026-09-24T08:15:40Z',
    });
    expect(run).toMatchObject({ id: 'f1', runId: '08584000000000000000CU12', workflowId: 'w1', flowName: 'Notify underwriter', status: 'failed', durationMs: 9120, precision: 's' });
    expect(run.end! - run.start).toBe(9000);
    expect(mapFlowRun({ flowrunid: 'f2', starttime: '2026-09-24T08:14:03Z', status: 'Running' })).toMatchObject({ status: 'running', end: null, durationMs: null });
  });

  it('maps a flow event', () => {
    expect(mapFlowEvent({ floweventid: 'e1', eventtype: 'FlowRunIngestion', eventcode: 'Delayed', level: 'Warning', createdon: '2026-09-24T08:00:00Z' })).toMatchObject({ id: 'e1', eventType: 'FlowRunIngestion', level: 'Warning' });
  });

  it('folds workflow activations into their definition and parses flow triggers', () => {
    const clientdata = JSON.stringify({
      properties: { definition: { triggers: { t: { inputs: { parameters: { 'subscriptionRequest/message': 3, 'subscriptionRequest/entityname': 'account', 'subscriptionRequest/filteringattributes': 'name, telephone1' } } } } } },
    });
    const processes = mapProcesses(
      [
        { workflowid: 'W1', name: 'Risk', category: 0, type: 1, statecode: 1, primaryentity: 'hbr_policy', mode: 0, triggeroncreate: true, triggeronupdateattributelist: 'hbr_premium,hbr_status' },
        { workflowid: 'a1', category: 0, type: 2, _parentworkflowid_value: 'w1' },
        { workflowid: 'F1', name: 'Marketing', category: 5, type: 1, statecode: 0, primaryentity: 'account' },
        { workflowid: 'b1', name: 'Rule', category: 2, type: 1, statecode: 1, primaryentity: 'none' },
      ],
      new Map([['f1', clientdata]]),
    );
    const [risk, flow, rule] = processes;
    expect(risk).toMatchObject({ category: 'workflow', active: true, mode: 'background', triggerOnCreate: true, triggerOnUpdateAttributes: ['hbr_premium', 'hbr_status'], activationIds: ['a1', 'W1'] });
    expect(flow).toMatchObject({ category: 'flow', active: false, flowTrigger: { table: 'account', changes: ['update'], filteringAttributes: ['name', 'telephone1'] } });
    expect(rule).toMatchObject({ category: 'businessRule', primaryEntity: null, flowTrigger: null });
  });

  it('maps audit rows and reads changed columns from audit details', () => {
    const audit = mapAudit({
      auditid: 'au1',
      action: 2,
      [`action${FV}`]: 'Update',
      operation: 2,
      createdon: '2026-09-24T08:14:01Z',
      _userid_value: 'u1',
      [`_userid_value${FV}`]: 'Jamie Ortiz',
      transactionid: 't1',
      _objectid_value: 'r1',
      objecttypecode: 'hbr_policy',
    });
    expect(audit).toMatchObject({ id: 'au1', table: 'hbr_policy', recordId: 'r1', operation: 'update', actionLabel: 'Update', userName: 'Jamie Ortiz', changedColumns: null });
    const changes = auditChanges({
      AuditDetail: {
        '@odata.type': '#Microsoft.Dynamics.CRM.AttributeAuditDetail',
        OldValue: { '@odata.type': '#Microsoft.Dynamics.CRM.hbr_policy', hbr_status: 1, _ownerid_value: 'u1' },
        NewValue: { '@odata.type': '#Microsoft.Dynamics.CRM.hbr_policy', hbr_status: 2, [`hbr_status${FV}`]: 'Active', _ownerid_value: 'u2' },
      },
    });
    expect(changes).toEqual({ changedColumns: ['hbr_status', 'ownerid'], newValues: { hbr_status: 2, ownerid: 'u2' } });
  });
});
