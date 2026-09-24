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
