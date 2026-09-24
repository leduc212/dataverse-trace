// Every Web API query the app sends, in one place. Keep these to the OData subset the demo's
// MockTransport understands: $select, $filter (eq/ne/gt/ge/lt/le, and/or, In()), $orderby, $top, $expand.

/** ISO timestamp for a $filter literal. */
export const iso = (ms: number) => new Date(ms).toISOString();

export const TRACE_LOG_COLUMNS = [
  'plugintracelogid',
  'correlationid',
  'requestid',
  'pluginstepid',
  'typename',
  'messagename',
  'primaryentity',
  'mode',
  'operationtype',
  'depth',
  'performanceexecutionstarttime',
  'performanceexecutionduration',
  'performanceconstructorduration',
  'exceptiondetails',
  'createdon',
  '_createdby_value',
];

/** Trace log metadata (no messageblock), oldest first, from `since` (inclusive: timestamps are whole seconds). */
export const traceLogsQuery = (since: number | null): string =>
  `plugintracelogs?$select=${TRACE_LOG_COLUMNS.join(',')}` +
  (since !== null ? `&$filter=createdon ge ${iso(since)}` : '') +
  '&$orderby=createdon asc,plugintracelogid asc';

/** Trace text, fetched in a separate, slower lane. */
export const traceBlobsQuery = (since: number | null): string =>
  'plugintracelogs?$select=plugintracelogid,messageblock,createdon' +
  (since !== null ? `&$filter=createdon ge ${iso(since)}` : '') +
  '&$orderby=createdon asc,plugintracelogid asc';

export const ASYNC_OPERATION_COLUMNS = [
  'asyncoperationid',
  'name',
  'correlationid',
  'requestid',
  'operationtype',
  'statuscode',
  'depth',
  '_owningextensionid_value',
  '_workflowactivationid_value',
  '_regardingobjectid_value',
  'primaryentitytype',
  'messagename',
  'createdon',
  'startedon',
  'completedon',
  'modifiedon',
  'retrycount',
  'errorcode',
  'friendlymessage',
  'message',
];

/** System events (async plugins, 1) and workflows (10), changed since `since`. */
export const asyncOperationsQuery = (since: number): string =>
  `asyncoperations?$select=${ASYNC_OPERATION_COLUMNS.join(',')}` +
  `&$filter=modifiedon ge ${iso(since)} and (operationtype eq 1 or operationtype eq 10)` +
  '&$orderby=modifiedon asc,asyncoperationid asc';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plugin steps by id, with message, table and plugin type. */
export function stepsByIdQuery(ids: readonly string[]): string {
  const safe = ids.filter((id) => GUID.test(id));
  if (safe.length === 0) throw new Error('No valid step ids');
  const values = safe.map((id) => `'${id}'`).join(',');
  return (
    'sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,asyncautodelete,ismanaged,_impersonatinguserid_value' +
    `&$filter=Microsoft.Dynamics.CRM.In(PropertyName='sdkmessageprocessingstepid',PropertyValues=[${values}])` +
    '&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode),plugintypeid($select=typename,assemblyname)'
  );
}

export const orgSettingColumns = ['plugintracelogsetting', 'isauditenabled', 'maxuploadfilesize'] as const;
export const orgSettingQuery = (column: string) => `organizations?$select=${column}`;

/** Role template id of the built-in System Administrator role (the same in every environment). */
export const SYSTEM_ADMINISTRATOR_ROLE_TEMPLATE = '627090ff-40a3-4053-8790-584edc5be201';

export const userRolesQuery = (userId: string) => `systemusers(${userId})/systemuserroles_association?$select=roleid,_roletemplateid_value`;
export const userTeamsQuery = (userId: string) => `systemusers(${userId})/teammembership_association?$select=teamid`;
export const teamRolesQuery = (teamId: string) => `teams(${teamId})/teamroles_association?$select=roleid,_roletemplateid_value`;

// ── v0.2: flows, processes, audit, on-demand lookups ─────────────────────────

export const FLOW_RUN_COLUMNS = [
  'flowrunid',
  'name',
  'starttime',
  'endtime',
  'duration',
  'status',
  'triggertype',
  'errorcode',
  'errormessage',
  'parentrunid',
  'workflowid',
  '_workflow_value',
  'createdon',
  'modifiedon',
  '_ownerid_value',
];

/** Flow runs changed since `since` (flowrun is an elastic table: flat filters only). */
export const flowRunsQuery = (since: number): string =>
  `flowruns?$select=${FLOW_RUN_COLUMNS.join(',')}&$filter=modifiedon ge ${iso(since)}&$orderby=modifiedon asc,flowrunid asc`;

/** Signals that flow run history is incomplete. */
export const flowEventsQuery = (since: number): string =>
  "flowevents?$select=floweventid,eventtype,eventcode,level,name,createdon,_parentobjectid_value" +
  `&$filter=eventtype eq 'FlowRunIngestion' and createdon ge ${iso(since)}&$orderby=createdon asc,floweventid asc`;

/** Classic workflows (definitions and activations), business rules and cloud flows (definitions). */
export const processesQuery = (): string =>
  'workflows?$select=workflowid,name,category,statecode,type,primaryentity,mode,scope,triggeroncreate,triggerondelete,triggeronupdateattributelist,_parentworkflowid_value,modifiedon' +
  '&$filter=(category eq 0 and (type eq 1 or type eq 2)) or ((category eq 2 or category eq 5) and type eq 1)' +
  '&$orderby=workflowid asc';

/** Cloud flow definitions with their trigger JSON. clientdata is large, so it's fetched on its own. */
export const flowDefinitionsQuery = (): string => 'workflows?$select=workflowid,clientdata&$filter=category eq 5 and type eq 1&$orderby=workflowid asc';

/** Plugin steps registered for a table and message, in the stages that matter. */
export function stepsForTableQuery(table: string, message: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^[A-Za-z]+$/.test(message)) throw new Error('Invalid table or message');
  return (
    'sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,mode,rank,filteringattributes,statecode,asyncautodelete,ismanaged,_impersonatinguserid_value' +
    `&$filter=sdkmessagefilterid/primaryobjecttypecode eq '${table.toLowerCase()}' and sdkmessageid/name eq '${message}' and (stage eq 10 or stage eq 20 or stage eq 40)` +
    '&$expand=sdkmessageid($select=name),sdkmessagefilterid($select=primaryobjecttypecode),plugintypeid($select=typename,assemblyname)'
  );
}

/** Recent audit rows of one record. */
export function auditsQuery(recordId: string, top = 100): string {
  if (!GUID.test(recordId)) throw new Error('Invalid record id');
  return (
    'audits?$select=auditid,action,operation,createdon,_userid_value,transactionid,_objectid_value,objecttypecode' +
    `&$filter=_objectid_value eq ${recordId}&$orderby=createdon desc&$top=${top}`
  );
}

/** Old and new values for one audit row. */
export function auditDetailsQuery(auditId: string): string {
  if (!GUID.test(auditId)) throw new Error('Invalid audit id');
  return `audits(${auditId})/Microsoft.Dynamics.CRM.RetrieveAuditDetails`;
}

export function entityMetadataQuery(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('Invalid table name');
  return `EntityDefinitions(LogicalName='${table.toLowerCase()}')?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute`;
}

export function recordQuery(entitySet: string, recordId: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(entitySet) || !GUID.test(recordId)) throw new Error('Invalid entity set or id');
  return `${entitySet}(${recordId})`;
}

export const organizationIdQuery = () => 'organizations?$select=organizationid,plugintracelogsetting';

/** Records whose primary name contains `text` (for the record picker). */
export function recordSearchQuery(entitySet: string, primaryId: string, primaryName: string, text: string, top = 10): string {
  for (const name of [entitySet, primaryId, primaryName]) if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('Invalid metadata');
  const literal = text.trim().slice(0, 100).replace(/'/g, "''");
  return `${entitySet}?$select=${primaryId},${primaryName}&$filter=contains(${primaryName},'${encodeURIComponent(literal)}')&$orderby=${primaryName} asc&$top=${top}`;
}

/** The platform's own counters per plug-in type (small: one row per type). */
export const pluginTypeStatisticsQuery = (): string =>
  'plugintypestatistics?$select=plugintypestatisticid,_plugintypeid_value,executecount,failurecount,failurepercent,crashcount,crashpercent,crashcontributionpercent,' +
  'averageexecutetimeinmilliseconds,terminatecpucontributionpercent,terminatememorycontributionpercent,terminatehandlescontributionpercent,terminateothercontributionpercent,modifiedon' +
  '&$orderby=plugintypestatisticid asc';

/** Live Dataverse trigger subscriptions of cloud flows (to check that a flow's trigger is really registered). */
export const callbackRegistrationsQuery = (): string =>
  'callbackregistrations?$select=callbackregistrationid,name,entityname,message,filteringattributes,filterexpression,scope&$orderby=callbackregistrationid asc';
