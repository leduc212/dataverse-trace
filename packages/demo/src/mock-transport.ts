// In-memory stand-in for the Dataverse Web API, serving a DemoDataset. Implements the same
// Transport interface as FetchTransport, so demo mode exercises the real sync engine and mappers.
import { HttpError, type ODataPage, type RequestOptions, type Transport } from '@dvt/dataverse';
import type { DemoDataset, SimulatedSave } from './generator.ts';
import { evaluate, parseRequest, project, sortRows, type Row } from '@dvt/core';

export interface MockTransportOptions {
  /** Simulated network latency per request. */
  latencyMs?: number;
  /** Entity sets that answer 403, to simulate missing privileges. */
  forbidden?: string[];
  /** Largest page size when the caller doesn't ask for one (the platform default is 5,000). */
  defaultPageSize?: number;
}

export class MockTransport implements Transport {
  readonly #data: DemoDataset;
  readonly #options: MockTransportOptions;
  readonly #tables: Record<string, Row[]>;
  /** Number of requests served, for tests and the demo's status panel. */
  requests = 0;
  /** PATCH requests received, in order (the app's only write is the trace setting). */
  readonly patches: Array<{ path: string; body: unknown }> = [];
  /** Rows of simulated saves that aren't visible yet. */
  #pending: SimulatedSave['rows'] = [];
  readonly #clock: () => number;

  constructor(data: DemoDataset, options: MockTransportOptions = {}, clock: () => number = Date.now) {
    this.#data = data;
    this.#options = options;
    this.#clock = clock;
    this.#tables = {
      plugintracelogs: data.traceLogs,
      asyncoperations: data.asyncOperations,
      sdkmessageprocessingsteps: data.steps,
      organizations: [data.organization],
      flowruns: data.flowRuns,
      flowevents: data.flowEvents,
      workflows: data.workflows,
      callbackregistrations: data.callbackRegistrations,
      plugintypestatistics: data.pluginTypeStatistics,
      audits: data.audits,
    };
  }

  /** Adds a simulated save; its rows appear as their time comes. */
  schedule(save: SimulatedSave): void {
    Object.assign(this.#data.auditDetails, save.auditDetails);
    this.#pending.push(...save.rows);
    this.#pending.sort((a, b) => a.at - b.at);
  }

  /** Number of simulated rows not visible yet. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  #release(): void {
    const now = this.#clock();
    while (this.#pending.length && this.#pending[0]!.at <= now) {
      const { table, row } = this.#pending.shift()!;
      this.#tables[table]!.push(row);
    }
  }

  async patch(path: string, body: unknown): Promise<void> {
    this.requests++;
    if (this.#options.latencyMs) await new Promise((r) => setTimeout(r, this.#options.latencyMs));
    const request = parseRequest(path);
    if (this.#options.forbidden?.includes(request.resource)) throw new HttpError(403, `Principal user is missing prvWrite${request.resource} privilege.`);
    const row = request.key ? this.#tables[request.resource]?.find((r) => Object.entries(r).some(([k, v]) => k.endsWith('id') && String(v).toLowerCase() === request.key)) : undefined;
    if (!row) throw new HttpError(404, `Resource not found for the segment '${path}'.`);
    this.patches.push({ path, body });
    Object.assign(row, body);
    const labels: Record<number, string> = { 0: 'Off', 1: 'Exception', 2: 'All' };
    const setting = (body as Row)['plugintracelogsetting'];
    if (typeof setting === 'number') row['plugintracelogsetting@OData.Community.Display.V1.FormattedValue'] = labels[setting];
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    this.requests++;
    if (this.#options.latencyMs) await new Promise((r) => setTimeout(r, this.#options.latencyMs));
    options.signal?.throwIfAborted();
    this.#release();

    const request = parseRequest(path);
    if (this.#options.forbidden?.includes(request.resource)) {
      throw new HttpError(403, `Principal user is missing prvRead${request.resource} privilege.`);
    }
    if (request.resource === 'WhoAmI') {
      return { UserId: this.#data.userId, BusinessUnitId: '1c7b0d9e-5a2f-4e6b-8c31-9f0a2d4b6e18', OrganizationId: this.#data.organizationId } as T;
    }
    if (request.resource === 'EntityDefinitions' && request.key) {
      const entity = this.#data.entities[request.key];
      if (!entity) throw new HttpError(404, `Could not find an entity with name '${request.key}'.`);
      return { ...entity } as T;
    }
    if (request.resource === 'audits' && request.key && request.navigation === 'Microsoft.Dynamics.CRM.RetrieveAuditDetails') {
      const details = this.#data.auditDetails[request.key];
      if (!details) throw new HttpError(404, `Audit ${request.key} does not exist.`);
      return structuredClone(details) as T;
    }
    if (request.navigation) return this.#page(this.#navigation(request.resource, request.navigation), request, options) as T;
    if (request.key) return this.#single(request, options) as T;

    const table = this.#tables[request.resource] ?? this.#entityRows(request.resource);
    if (!table) throw new HttpError(404, `Resource not found for the segment '${request.resource}'.`);
    return this.#page(table, request, options) as T;
  }

  /** Rows of a demo business table by entity set (hbr_policies, accounts, …), or undefined. */
  #entityRows(entitySet: string): Row[] | undefined {
    const entity = Object.values(this.#data.entities).find((e) => e.EntitySetName === entitySet);
    return entity ? Object.values(this.#data.records[entity.LogicalName] ?? {}) : undefined;
  }

  /** `entityset(id)`: one record of a demo table. */
  #single(request: ReturnType<typeof parseRequest>, options: RequestOptions): Row {
    const entity = Object.values(this.#data.entities).find((e) => e.EntitySetName === request.resource);
    const row = entity ? this.#data.records[entity.LogicalName]?.[request.key!] : undefined;
    if (!row) throw new HttpError(404, `${request.resource} with id ${request.key} does not exist.`);
    return project(row, request, options.annotations !== false);
  }

  #navigation(resource: string, navigation: string): Row[] {
    if (resource === 'systemusers' && navigation === 'systemuserroles_association') return this.#data.userRoles;
    if (resource === 'systemusers' && navigation === 'teammembership_association') return [];
    if (resource === 'teams' && navigation === 'teamroles_association') return [];
    throw new HttpError(404, `Resource not found for the segment '${navigation}'.`);
  }

  #page(rows: Row[], request: ReturnType<typeof parseRequest>, options: RequestOptions): ODataPage<Row> {
    const filtered = request.filter ? rows.filter((r) => evaluate(request.filter!, r)) : rows;
    const sorted = sortRows(filtered, request.orderBy);
    const limited = request.top !== undefined ? sorted.slice(0, request.top) : sorted;
    const pageSize = options.maxPageSize ?? this.#options.defaultPageSize ?? 5000;
    const slice = limited.slice(request.skip, request.skip + pageSize);
    const page: ODataPage<Row> = { value: slice.map((r) => project(r, request, options.annotations !== false)) };
    if (request.skip + pageSize < limited.length) {
      const params = request.params.filter(([k]) => k !== '$skiptoken');
      params.push(['$skiptoken', String(request.skip + pageSize)]);
      const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const resource = request.key ? `${request.resource}(${request.key})/${request.navigation}` : request.resource;
      page['@odata.nextLink'] = `${resource}?${query}`;
    }
    return page;
  }
}
