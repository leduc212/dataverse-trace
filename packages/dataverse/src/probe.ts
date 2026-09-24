// Capability probe: what can this user read in this environment, and what's switched on?
// Every check is tolerant: a failure becomes "can't" plus a human-readable reason, never an exception.
import type { OrganizationSettings } from '@dvt/core';
import { formatted, type Raw } from './mappers.ts';
import {
  SYSTEM_ADMINISTRATOR_ROLE_TEMPLATE,
  orgSettingColumns,
  orgSettingQuery,
  teamRolesQuery,
  userRolesQuery,
  userTeamsQuery,
} from './queries.ts';
import { HttpError, getAll, type ODataPage, type Transport } from './transport.ts';

export interface Capabilities {
  userId: string | null;
  organizationId: string | null;
  settings: OrganizationSettings;
  canReadTraceLogs: boolean;
  /** Trace text is only returned to System Administrators. `null` = couldn't tell. */
  canReadTraceText: boolean | null;
  isSystemAdministrator: boolean | null;
  canReadAsyncOperations: boolean;
  canReadSteps: boolean;
  canReadFlowRuns: boolean;
  canReadProcesses: boolean;
  /** Needs prvReadAuditSummary (and auditing turned on to be useful). */
  canReadAudit: boolean;
  /** The platform's per-plug-in-type counters, which work even with tracing off. */
  canReadPluginStats: boolean;
  /** Human-readable explanations for anything missing. */
  notes: string[];
  checkedAt: number;
}

const reason = (e: unknown) =>
  e instanceof HttpError ? (e.status === 403 || e.status === 401 ? 'no read privilege' : `${e.status}: ${e.message}`) : String(e);

async function canRead(transport: Transport, path: string): Promise<{ ok: boolean; why?: string }> {
  try {
    await transport.get<ODataPage<Raw>>(path, { annotations: false });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: reason(e) };
  }
}

async function readSettings(transport: Transport, notes: string[]): Promise<OrganizationSettings> {
  const settings: OrganizationSettings = { pluginTraceLogSetting: null, isAuditEnabled: null, maxUploadFileSize: null };
  for (const column of orgSettingColumns) {
    try {
      const row = (await transport.get<ODataPage<Raw>>(orgSettingQuery(column))).value[0] ?? {};
      const v = row[column];
      if (column === 'plugintracelogsetting' && (v === 0 || v === 1 || v === 2)) settings.pluginTraceLogSetting = v;
      if (column === 'isauditenabled' && typeof v === 'boolean') settings.isAuditEnabled = v;
      if (column === 'maxuploadfilesize' && typeof v === 'number') settings.maxUploadFileSize = v;
    } catch (e) {
      notes.push(`Couldn't read the organization setting ${column} (${reason(e)}).`);
    }
  }
  return settings;
}

async function isSystemAdministrator(transport: Transport, userId: string): Promise<boolean | null> {
  const hasAdminRole = (roles: Raw[]) => roles.some((r) => String(r['_roletemplateid_value']).toLowerCase() === SYSTEM_ADMINISTRATOR_ROLE_TEMPLATE);
  try {
    if (hasAdminRole(await getAll<Raw>(transport, userRolesQuery(userId)))) return true;
    const teams = await getAll<Raw>(transport, userTeamsQuery(userId));
    for (const team of teams.slice(0, 50)) {
      if (hasAdminRole(await getAll<Raw>(transport, teamRolesQuery(String(team['teamid']))))) return true;
    }
    return false;
  } catch {
    return null;
  }
}

export async function probeCapabilities(transport: Transport, now: () => number = Date.now): Promise<Capabilities> {
  const notes: string[] = [];
  let userId: string | null = null;
  let organizationId: string | null = null;
  try {
    const who = await transport.get<{ UserId: string; OrganizationId: string }>('WhoAmI', { annotations: false });
    userId = who.UserId;
    organizationId = who.OrganizationId;
  } catch (e) {
    notes.push(`Couldn't call WhoAmI (${reason(e)}). Is the page open inside a Dataverse environment?`);
  }

  const settings = await readSettings(transport, notes);
  if (settings.pluginTraceLogSetting === 0) {
    notes.push('Plug-in trace logging is Off, so no new trace logs are written. Set it to Exceptions or All.');
  } else if (settings.pluginTraceLogSetting === 1) {
    notes.push('Plug-in trace logging is set to Exceptions: only failing executions are logged.');
  }

  const [traceLogs, asyncOps, steps, flowRuns, processes, audit, pluginStats] = await Promise.all([
    canRead(transport, 'plugintracelogs?$select=plugintracelogid&$top=1'),
    canRead(transport, 'asyncoperations?$select=asyncoperationid&$top=1'),
    canRead(transport, 'sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid&$top=1'),
    canRead(transport, 'flowruns?$select=flowrunid&$top=1'),
    canRead(transport, 'workflows?$select=workflowid&$top=1'),
    canRead(transport, 'audits?$select=auditid&$top=1'),
    canRead(transport, 'plugintypestatistics?$select=plugintypestatisticid&$top=1'),
  ]);
  if (!traceLogs.ok) notes.push(`Can't read plug-in trace logs (${traceLogs.why}).`);
  if (!asyncOps.ok) notes.push(`Can't read system jobs (${asyncOps.why}); the async lane will be limited.`);
  if (!steps.ok) notes.push(`Can't read plug-in step registrations (${steps.why}); stage and order will be unknown.`);
  if (!flowRuns.ok) notes.push(`Can't read cloud flow run history (${flowRuns.why}); record stories won't include flows.`);
  if (!processes.ok) notes.push(`Can't read processes (${processes.why}); expected vs. actual won't include flows and workflows.`);
  if (!audit.ok) notes.push(`Can't read audit history (${audit.why}); record stories will rely on system jobs only.`);
  else if (settings.isAuditEnabled === false) notes.push('Auditing is off for this environment, so record stories can only find saves that started system jobs.');
  if (!pluginStats.ok) notes.push(`Can't read plug-in type statistics (${pluginStats.why}); the platform statistics panel will be empty.`);

  const admin = userId ? await isSystemAdministrator(transport, userId) : null;
  let canReadTraceText: boolean | null = admin;
  if (admin === null && traceLogs.ok) {
    // Couldn't read roles: fall back to looking at recent rows.
    try {
      const rows = (await transport.get<ODataPage<Raw>>('plugintracelogs?$select=messageblock&$orderby=createdon desc&$top=10', { annotations: false })).value;
      if (rows.some((r) => typeof r['messageblock'] === 'string' && r['messageblock'] !== '')) canReadTraceText = true;
    } catch {
      // Leave as unknown.
    }
  }
  if (canReadTraceText === false) {
    notes.push('Trace text (messageblock) is only returned to System Administrators, so trace text will be empty for you.');
  }

  return {
    userId,
    organizationId,
    settings,
    canReadTraceLogs: traceLogs.ok,
    canReadTraceText,
    isSystemAdministrator: admin,
    canReadAsyncOperations: asyncOps.ok,
    canReadSteps: steps.ok,
    canReadFlowRuns: flowRuns.ok,
    canReadProcesses: processes.ok,
    canReadAudit: audit.ok,
    canReadPluginStats: pluginStats.ok,
    notes,
    checkedAt: now(),
  };
}

/** Human label for the trace setting, using the formatted value when available. */
export const traceSettingLabel = (row: Raw) => formatted(row, 'plugintracelogsetting');
