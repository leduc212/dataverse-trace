// Reads made on demand for one record or one table (not synced in the background): audit history,
// the record's values, table metadata, and plugin steps for expected vs. actual.
import type { AuditRecord, ChangeKind, StepRegistration } from '@dvt/core';
import { auditChanges, formatted, mapAudit, mapStep, type Raw } from './mappers.ts';
import { auditDetailsQuery, auditsQuery, entityMetadataQuery, organizationIdQuery, recordQuery, recordSearchQuery, stepsForTableQuery } from './queries.ts';
import { getAll, type ODataPage, type Transport } from './transport.ts';

const MESSAGES: Record<ChangeKind, string> = { create: 'Create', update: 'Update', delete: 'Delete' };

export function fetchStepsForTable(transport: Transport, table: string, change: ChangeKind): Promise<StepRegistration[]> {
  return getAll<Raw>(transport, stepsForTableQuery(table, MESSAGES[change])).then((rows) => rows.map(mapStep));
}

/**
 * A record's recent audit history. Changed columns need one extra request per audit row, so only
 * the newest `withDetails` rows get them; the rest have `changedColumns: null`.
 */
export async function fetchAudits(transport: Transport, recordId: string, options: { top?: number; withDetails?: number } = {}): Promise<AuditRecord[]> {
  const rows = (await transport.get<ODataPage<Raw>>(auditsQuery(recordId, options.top ?? 100))).value;
  const audits = rows.map(mapAudit);
  const detailed = audits.filter((a) => a.operation !== 'other').slice(0, options.withDetails ?? 20);
  await Promise.all(
    detailed.map(async (a) => {
      try {
        const changes = auditChanges(await transport.get<Raw>(auditDetailsQuery(a.id)));
        a.changedColumns = changes.changedColumns;
        a.newValues = changes.newValues;
      } catch {
        // Leave the columns unknown for this row.
      }
    }),
  );
  return audits;
}

/** Loads details for audit rows that don't have them yet. */
export async function fetchAuditDetails(transport: Transport, audits: AuditRecord[]): Promise<AuditRecord[]> {
  return Promise.all(
    audits.map(async (a) => {
      if (a.changedColumns !== null || a.operation === 'other') return a;
      try {
        const changes = auditChanges(await transport.get<Raw>(auditDetailsQuery(a.id)));
        return { ...a, ...changes };
      } catch {
        return a;
      }
    }),
  );
}

export interface EntityMetadata {
  table: string;
  entitySet: string;
  primaryId: string;
  primaryName: string | null;
}

export async function fetchEntityMetadata(transport: Transport, table: string): Promise<EntityMetadata> {
  const row = await transport.get<Raw>(entityMetadataQuery(table), { annotations: false });
  return {
    table: String(row['LogicalName'] ?? table),
    entitySet: String(row['EntitySetName']),
    primaryId: String(row['PrimaryIdAttribute']),
    primaryName: typeof row['PrimaryNameAttribute'] === 'string' ? row['PrimaryNameAttribute'] : null,
  };
}

export interface RecordSnapshot {
  table: string;
  id: string;
  name: string | null;
  /** Column values by logical name; lookups as `x` (their id), without annotations. */
  values: Record<string, unknown>;
}

export async function fetchRecord(transport: Transport, metadata: EntityMetadata, id: string): Promise<RecordSnapshot> {
  const row = await transport.get<Raw>(recordQuery(metadata.entitySet, id));
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.includes('@')) continue;
    const lookup = /^_(.+)_value$/.exec(key);
    values[lookup ? lookup[1]! : key] = value;
  }
  const name = metadata.primaryName ? (values[metadata.primaryName] ?? formatted(row, metadata.primaryName) ?? null) : null;
  return { table: metadata.table, id, name: typeof name === 'string' ? name : null, values };
}

/** Records of a table whose primary name contains `text`. */
export async function searchRecords(transport: Transport, metadata: EntityMetadata, text: string): Promise<Array<{ table: string; id: string; name: string | null }>> {
  if (!metadata.primaryName || !text.trim()) return [];
  const rows = (await transport.get<ODataPage<Raw>>(recordSearchQuery(metadata.entitySet, metadata.primaryId, metadata.primaryName, text), { annotations: false })).value;
  return rows.map((r) => ({ table: metadata.table, id: String(r[metadata.primaryId]), name: typeof r[metadata.primaryName!] === 'string' ? (r[metadata.primaryName!] as string) : null }));
}

/** Reads the organization id and trace setting (needed to change the setting). */
export async function fetchOrganization(transport: Transport): Promise<{ id: string; traceSetting: 0 | 1 | 2 | null }> {
  const row = (await transport.get<ODataPage<Raw>>(organizationIdQuery(), { annotations: false })).value[0] ?? {};
  const setting = row['plugintracelogsetting'];
  return { id: String(row['organizationid']), traceSetting: setting === 0 || setting === 1 || setting === 2 ? setting : null };
}

/** The app's only write. Callers must have the user's explicit consent and must restore it. */
export async function setTraceSetting(transport: Transport, organizationId: string, value: 0 | 1 | 2): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) throw new Error('Invalid organization id');
  await transport.patch(`organizations(${organizationId})`, { plugintracelogsetting: value });
}
